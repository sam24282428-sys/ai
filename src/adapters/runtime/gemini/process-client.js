const { spawn } = require("child_process");

const GEMINI_FALLBACK_CHAIN = [
  { model: "gemini-4-hydrogen-medium", effort: "medium" },
  { model: "gemini-4-neon-low", effort: "low" },
  { model: "gemini-4-argon-low", effort: "low" },
  { model: "gemini-4-hydrogen-low", effort: "low" },
];

class GeminiProcessClient {
  constructor({
    command = "agy",
    cwd,
    env,
    model = "gemini-4-hydrogen-medium",
    effort = "medium",
    extraArgs = [],
    ipcServer = null,
    workspaceRoot = "",
  }) {
    const resolved = resolveGeminiModelAndEffort(model, effort);
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.model = resolved.model;
    this.effort = resolved.effort;
    this.extraArgs = Array.isArray(extraArgs) ? extraArgs : [];
    this.ipcServer = ipcServer;
    this.workspaceRoot = workspaceRoot;
    this.child = null;
    this.stdin = null;
    this.stdoutBuffer = "";
    this.listeners = new Set();
    this.pendingTurnId = "";
    this.turnStartedEmitted = false;
    this.sessionId = "";
    this.resumeSessionId = "";
    this.activeThreadId = "";
    this.alive = false;
    this.sessionWaiters = new Set();
    this.suppressNextCloseEvent = false;
    this.accumulatedResponse = "";
    this.idleSettleTimer = null;
    this.lastUserText = "";
    this.currentFallbackAttempt = 0;
    this.isRetryingFallback = false;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event, raw) {
    if (this.ipcServer) {
      this.ipcServer.broadcast({ type: "processEvent", event, raw });
    }
    for (const listener of this.listeners) {
      try {
        listener(event, raw);
      } catch {
        // ignore listener errors
      }
    }
  }

  async connect(resumeSessionId = "") {
    if (this.child && this.alive) {
      return;
    }

    const args = buildGeminiArgs({
      resumeSessionId,
      model: this.model,
      effort: this.effort,
      extraArgs: this.extraArgs,
    });

    this.resumeSessionId = normalizeSessionId(resumeSessionId);
    if (isValidSessionId(this.resumeSessionId)) {
      this.sessionId = this.resumeSessionId;
    }
    this.activeThreadId = this.sessionId || this.resumeSessionId || "";

    this.child = spawn(this.command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.stdin = this.child.stdin;
    this.stdoutBuffer = "";
    this.alive = true;
    this.suppressNextCloseEvent = false;
    this.accumulatedResponse = "";

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += String(chunk);
      let newlineIndex = this.stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          this.handleStdoutLine(line);
        }
        newlineIndex = this.stdoutBuffer.indexOf("\n");
      }
    });

    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        console.error(`[gemini stderr] ${text.slice(0, 300)}`);
      }
    });

    this.child.on("close", (code) => {
      this.alive = false;
      this.rejectSessionWaiters(new Error(`Gemini CLI exited before session was established (code=${code ?? "unknown"})`));
      const hadPendingTurn = Boolean(this.pendingTurnId);
      const failedTurnId = this.pendingTurnId || `turn-${Date.now()}`;
      this.pendingTurnId = "";
      this.accumulatedResponse = "";
      const shouldSuppressCloseEvent = this.suppressNextCloseEvent;
      this.suppressNextCloseEvent = false;
      if (!shouldSuppressCloseEvent && (hadPendingTurn || (code !== 0 && code !== null))) {
        this.emit({
          type: "turn.failed",
          sessionId: this.getEffectiveSessionId(),
          turnId: failedTurnId,
          error: code !== 0 && code !== null
            ? `Gemini client exited with code ${code}`
            : "Gemini client stopped before completing the turn",
        });
      }
    });

    this.child.on("error", (err) => {
      this.alive = false;
      this.rejectSessionWaiters(err);
      console.error(`[gemini error] ${err.message}`);
    });
  }

  handleStdoutLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const eventType = parsed?.event;
    if (eventType === "init") {
      const convId = normalizeSessionId(parsed.conversation_id);
      if (isValidSessionId(convId)) {
        this.sessionId = convId;
        this.activeThreadId = convId;
        this.resolveSessionWaiters(convId);
        if (this.pendingTurnId && !this.turnStartedEmitted) {
          this.turnStartedEmitted = true;
          this.emit({
            type: "turn.started",
            sessionId: convId,
            turnId: this.pendingTurnId,
          });
        }
      }
      return;
    }

    if (eventType === "step_update") {
      const step = parsed.step_update || {};
      const convId = normalizeSessionId(step.conversation_id);
      if (isValidSessionId(convId) && !this.sessionId) {
        this.sessionId = convId;
        this.activeThreadId = convId;
        this.resolveSessionWaiters(convId);
      }
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
        this.accumulatedResponse += step.text_delta;
        this.scheduleIdleSettle();
      }
      return;
    }

    if (eventType === "result") {
      this.clearIdleSettle();
      if (!this.pendingTurnId) {
        return;
      }
      const result = parsed.result || {};
      const convId = normalizeSessionId(result.conversation_id);
      if (isValidSessionId(convId)) {
        this.sessionId = convId;
        this.activeThreadId = convId;
        this.resolveSessionWaiters(convId);
      }
      const sessionId = this.getEffectiveSessionId();
      const turnId = this.pendingTurnId || `turn-${Date.now()}`;

      if (result.usage && typeof result.usage === "object") {
        this.emit({
          type: "context.updated",
          sessionId,
          usage: result.usage,
        }, parsed);
      }

      const rawText = (typeof result.response === "string" && result.response.trim()
        ? result.response
        : this.accumulatedResponse).trim();
      const finalText = stripCapacityErrorLines(rawText);
      this.accumulatedResponse = "";

      if (finalText) {
        this.pendingTurnId = "";
        this.turnStartedEmitted = false;
        this.currentFallbackAttempt = 0;
        this.emit({
          type: "reply.completed",
          sessionId,
          turnId,
          text: finalText,
        }, parsed);
        this.emit({
          type: "turn.completed",
          sessionId,
          turnId,
          text: finalText,
        }, parsed);
        return;
      }

      if (String(result.status || "").toUpperCase() === "ERROR") {
        const errorText = String(result.error || "");
        if (isCapacityOrTransientError(errorText) && this.lastUserText && this.currentFallbackAttempt < GEMINI_FALLBACK_CHAIN.length) {
          void this.retryWithFallbackModel(errorText);
          return;
        }
        this.pendingTurnId = "";
        this.turnStartedEmitted = false;
        this.currentFallbackAttempt = 0;
        this.emit({
          type: "turn.failed",
          sessionId,
          turnId,
          error: result.error || "❌ Gemini client returned an error",
        }, parsed);
        return;
      }

      this.pendingTurnId = "";
      this.turnStartedEmitted = false;
      this.currentFallbackAttempt = 0;
      this.emit({
        type: "turn.completed",
        sessionId,
        turnId,
        text: finalText,
      }, parsed);
    }
  }

  async retryWithFallbackModel(reason = "") {
    if (this.isRetryingFallback) {
      return;
    }
    this.isRetryingFallback = true;
    try {
      const candidate = pickNextFallbackCandidate(this.model, this.currentFallbackAttempt);
      this.currentFallbackAttempt += 1;
      const resumeId = this.getEffectiveSessionId();
      console.warn(
        `[gemini fallback] capacity error on model=${this.model} (${reason.slice(0, 120)}); switching to model=${candidate.model} effort=${candidate.effort} attempt=${this.currentFallbackAttempt}`
      );
      this.model = candidate.model;
      this.effort = candidate.effort;
      this.suppressNextCloseEvent = true;
      if (this.stdin) {
        try {
          this.stdin.end();
        } catch {
          // ignore
        }
      }
      if (this.child) {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      this.child = null;
      this.stdin = null;
      this.alive = false;

      await this.connect(resumeId);
      const payload = JSON.stringify({
        event: "user",
        message: {
          content: this.lastUserText,
        },
      });
      if (this.stdin && this.alive) {
        this.stdin.write(payload + "\n");
      }
    } catch (err) {
      const sessionId = this.getEffectiveSessionId();
      const turnId = this.pendingTurnId || `turn-${Date.now()}`;
      this.pendingTurnId = "";
      this.turnStartedEmitted = false;
      this.currentFallbackAttempt = 0;
      this.emit({
        type: "turn.failed",
        sessionId,
        turnId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.isRetryingFallback = false;
    }
  }

  sendUserMessage(input, { threadId = "" } = {}) {
    if (!this.stdin || !this.alive) {
      throw new Error("Gemini client process is not running.");
    }

    const text = typeof input === "object" && input !== null ? String(input.text || "") : String(input || "");
    const requestedThreadId = typeof input === "object" && input !== null ? (input.threadId || threadId) : threadId;

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.clearIdleSettle();
    this.pendingTurnId = turnId;
    this.turnStartedEmitted = false;
    this.accumulatedResponse = "";
    this.lastUserText = text;
    this.currentFallbackAttempt = 0;
    if (normalizeSessionId(requestedThreadId)) {
      this.activeThreadId = normalizeSessionId(requestedThreadId);
    }

    const payload = JSON.stringify({
      event: "user",
      message: {
        content: text,
      },
    });

    this.stdin.write(payload + "\n");

    const effectiveSessionId = this.getEffectiveSessionId();
    if (effectiveSessionId) {
      this.turnStartedEmitted = true;
      this.emit({
        type: "turn.started",
        sessionId: effectiveSessionId,
        turnId,
      });
    }

    if (this.ipcServer) {
      this.ipcServer.broadcast({
        type: "userInput",
        sessionId: this.getEffectiveSessionId(),
        turnId,
        text,
        workspaceRoot: this.workspaceRoot,
      });
    }

    return { turnId };
  }

  scheduleIdleSettle(delayMs = 4500) {
    this.clearIdleSettle();
    if (!this.pendingTurnId) {
      return;
    }
    this.idleSettleTimer = setTimeout(() => {
      this.idleSettleTimer = null;
      if (!this.pendingTurnId) {
        return;
      }
      const finalText = this.accumulatedResponse.trim();
      if (!finalText) {
        return;
      }
      const sessionId = this.getEffectiveSessionId();
      const turnId = this.pendingTurnId;
      this.pendingTurnId = "";
      this.turnStartedEmitted = false;
      this.accumulatedResponse = "";
      this.emit({
        type: "reply.completed",
        sessionId,
        turnId,
        text: finalText,
      });
      this.emit({
        type: "turn.completed",
        sessionId,
        turnId,
        text: finalText,
      });
    }, delayMs);
  }

  clearIdleSettle() {
    if (this.idleSettleTimer) {
      clearTimeout(this.idleSettleTimer);
      this.idleSettleTimer = null;
    }
  }

  waitForSessionId({ timeoutMs = 20_000 } = {}) {
    if (isValidSessionId(this.sessionId)) {
      return Promise.resolve(this.sessionId);
    }
    if (!this.child || !this.alive) {
      return Promise.reject(new Error("Gemini client process is not running."));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          this.sessionWaiters.delete(waiter);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.sessionWaiters.delete(waiter);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.sessionWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for Gemini conversation_id after ${timeoutMs}ms`));
      }, timeoutMs);
      this.sessionWaiters.add(waiter);
    });
  }

  cancelTurn() {
    if (!this.child || !this.alive) {
      return;
    }
    this.suppressNextCloseEvent = true;
    try {
      this.child.kill("SIGINT");
    } catch {
      // ignore
    }
  }

  close() {
    this.clearIdleSettle();
    this.pendingTurnId = "";
    this.accumulatedResponse = "";
    this.rejectSessionWaiters(new Error("Gemini client process was closed."));
    if (this.stdin) {
      try {
        this.stdin.end();
      } catch {
        // ignore
      }
    }
    if (this.child) {
      this.suppressNextCloseEvent = true;
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    this.alive = false;
  }

  getEffectiveSessionId() {
    return this.sessionId || this.activeThreadId || this.resumeSessionId || "";
  }

  resolveSessionWaiters(sessionId) {
    for (const waiter of Array.from(this.sessionWaiters)) {
      waiter.resolve(sessionId);
    }
  }

  rejectSessionWaiters(error) {
    for (const waiter of Array.from(this.sessionWaiters)) {
      waiter.reject(error);
    }
  }
}

function buildGeminiArgs({ resumeSessionId, model, effort, extraArgs }) {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
  ];
  const resolved = resolveGeminiModelAndEffort(model, effort);
  if (resolved.model) {
    args.push("--model", resolved.model);
  }
  if (resolved.effort) {
    args.push("--effort", resolved.effort);
  }
  if (isValidSessionId(resumeSessionId)) {
    args.push("--conversation", resumeSessionId);
  }
  if (Array.isArray(extraArgs)) {
    for (const item of extraArgs) {
      if (typeof item === "string" && item.trim()) {
        args.push(item.trim());
      }
    }
  }
  return args;
}

function resolveGeminiModelFlag(model, effort) {
  return resolveGeminiModelAndEffort(model, effort).model;
}

function resolveGeminiModelAndEffort(model, effort) {
  const raw = String(model || "gemini-4-hydrogen-medium").trim().toLowerCase();
  const explicitEffort = ["low", "medium", "high", "xhigh"].includes(String(effort || "").trim().toLowerCase())
    ? String(effort).trim().toLowerCase()
    : "";
  const suffixMatch = raw.match(/-(low|medium|high|xhigh)$/);
  if (suffixMatch) {
    const modelEffort = suffixMatch[1];
    return {
      model: raw,
      effort: modelEffort,
    };
  }
  const effectiveEffort = explicitEffort || "medium";
  if (raw === "hydrogen" || raw === "gemini-4-hydrogen") {
    return {
      model: `gemini-4-hydrogen-${effectiveEffort}`,
      effort: effectiveEffort,
    };
  }
  if (raw === "neon" || raw === "gemini-4-neon") {
    return {
      model: `gemini-4-neon-${effectiveEffort}`,
      effort: effectiveEffort,
    };
  }
  if (raw === "argon" || raw === "gemini-4-argon") {
    return {
      model: `gemini-4-argon-${effectiveEffort}`,
      effort: effectiveEffort,
    };
  }
  return {
    model: raw || `gemini-4-hydrogen-${effectiveEffort}`,
    effort: effectiveEffort,
  };
}

function pickNextFallbackCandidate(currentModel, attemptIndex = 0) {
  const filtered = GEMINI_FALLBACK_CHAIN.filter((item) => item.model !== currentModel);
  const list = filtered.length ? filtered : GEMINI_FALLBACK_CHAIN;
  return list[attemptIndex % list.length];
}

function isCapacityOrTransientError(errorText) {
  return /503|UNAVAILABLE|No capacity available|RESOURCE_EXHAUSTED|overloaded|deadline exceeded|rate limit|429|conflicts with --effort/i.test(
    String(errorText || "")
  );
}

function stripCapacityErrorLines(text) {
  return String(text || "")
    .replace(/^.*API error \(attempt \d+\):.*$/gim, "")
    .replace(/^.*No capacity available for model.*$/gim, "")
    .trim();
}

function isValidSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function normalizeSessionId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

module.exports = {
  GeminiProcessClient,
  resolveGeminiModelFlag,
  resolveGeminiModelAndEffort,
};
