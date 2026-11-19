const fs = require("fs");
const path = require("path");
const os = require("os");
const { GeminiProcessClient, resolveGeminiModelFlag, resolveGeminiModelAndEffort } = require("./process-client");
const { mapGeminiMessageToRuntimeEvent } = require("./events");
const { ensureGeminiMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");

const GEMINI_INIT_SESSION_TIMEOUT_MS = 25_000;

const GEMINI_MODELS = [
  {
    id: "gemini-4-hydrogen-medium",
    model: "gemini-4-hydrogen-medium",
    displayName: "Gemini 4 Hydrogen (Medium - 推荐/容量充裕)",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "极速低思考延迟" },
      { reasoningEffort: "medium", description: "均衡中等思考" },
      { reasoningEffort: "high", description: "深度思考" },
    ],
  },
  {
    id: "gemini-4-hydrogen-low",
    model: "gemini-4-hydrogen-low",
    displayName: "Gemini 4 Hydrogen (Low - 最快)",
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "极速低思考延迟" },
      { reasoningEffort: "medium", description: "均衡中等思考" },
      { reasoningEffort: "high", description: "深度思考" },
    ],
  },
  {
    id: "gemini-4-hydrogen-high",
    model: "gemini-4-hydrogen-high",
    displayName: "Gemini 4 Hydrogen (High)",
    isDefault: false,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "极速低思考延迟" },
      { reasoningEffort: "medium", description: "均衡中等思考" },
      { reasoningEffort: "high", description: "深度思考" },
    ],
  },
  {
    id: "gemini-3.8-flash-low",
    model: "gemini-3.8-flash-low",
    displayName: "Gemini 3.8 Flash (Low)",
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "极速低思考延迟" },
      { reasoningEffort: "medium", description: "均衡中等思考" },
    ],
  },
  {
    id: "gemini-4-argon-low",
    model: "gemini-4-argon-low",
    displayName: "Gemini 4 Argon (Low)",
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "低思考" },
      { reasoningEffort: "medium", description: "中等思考" },
      { reasoningEffort: "high", description: "高思考" },
    ],
  },
  {
    id: "gemini-4-neon-low",
    model: "gemini-4-neon-low",
    displayName: "Gemini 4 Neon (Low)",
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "低思考" },
      { reasoningEffort: "medium", description: "中等思考" },
      { reasoningEffort: "high", description: "高思考" },
    ],
  },
];

function createGeminiRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "gemini" });
  const clientsByWorkspace = new Map();
  const pendingModelByWorkspaceRoot = new Map();
  const pendingEffortByWorkspaceRoot = new Map();
  const instructionsSentThreads = new Set();
  const configuredResolved = resolveGeminiModelAndEffort(
    config.geminiModel || "gemini-4-hydrogen-medium",
    normalizeEffort(config.geminiEffort) || "medium",
  );
  const configuredEffort = configuredResolved.effort;
  const configuredModel = configuredResolved.model;
  let globalListener = null;

  sessionStore.setAvailableModelCatalog(GEMINI_MODELS);

  function findBindingForWorkspaceRoot(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    for (const binding of sessionStore.listBindings()) {
      if (normalizeText(binding.activeWorkspaceRoot) === normalizedWorkspaceRoot) {
        return binding;
      }
    }
    return null;
  }

  function getOrCreateClient(workspaceRoot, resumeSessionId = "", { model = "", effort = "" } = {}) {
    const existing = clientsByWorkspace.get(workspaceRoot);
    if (existing && existing.alive) {
      return existing;
    }

    ensureGeminiMcpConfig({
      workspaceRoot,
      cyberbossHome: process.env.CYBERBOSS_HOME,
      stateDir: config.stateDir,
      geminiConfigDir: config.geminiConfigDir,
      latentEnabled: config.latentEnabled,
      latentPythonCommand: config.latentPythonCommand,
      latentCorpusDir: config.latentCorpusDir,
      latentThreadsFile: config.latentThreadsFile,
    });

    const resolvedPair = resolveGeminiModelAndEffort(
      normalizeText(model) || resolveWorkspaceModel(workspaceRoot) || configuredModel,
      normalizeEffort(effort) || resolveWorkspaceEffort(workspaceRoot) || configuredEffort,
    );
    const effectiveModel = resolvedPair.model;
    const effectiveEffort = resolvedPair.effort;

    const client = new GeminiProcessClient({
      command: config.geminiCommand || "agy",
      cwd: workspaceRoot,
      env: { ...process.env },
      model: effectiveModel,
      effort: effectiveEffort,
      extraArgs: config.geminiExtraArgs || [],
      workspaceRoot,
    });

    client.onMessage((message) => {
      if (message?.sessionId && isValidUuid(message.sessionId)) {
        const binding = findBindingForWorkspaceRoot(workspaceRoot);
        if (binding?.bindingKey) {
          const currentThreadId = sessionStore.getThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
          if (!currentThreadId) {
            sessionStore.setThreadIdForWorkspace(binding.bindingKey, workspaceRoot, message.sessionId);
          }
          sessionStore.setRuntimeParamsForWorkspace(binding.bindingKey, workspaceRoot, {
            model: normalizeText(client.model) || effectiveModel,
            reasoningEffort: normalizeEffort(client.effort) || effectiveEffort,
          });
        }
      }

      if (!globalListener) {
        return;
      }
      const event = mapGeminiMessageToRuntimeEvent(message);
      if (event) {
        globalListener(event);
      }
    });

    clientsByWorkspace.set(workspaceRoot, client);
    return client;
  }

  function resolveWorkspaceModel(workspaceRoot, { threadId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
    const pendingModel = normalizeText(pendingModelByWorkspaceRoot.get(normalizedWorkspaceRoot));
    if (pendingModel) {
      return pendingModel;
    }
    const binding = findBindingForWorkspaceRoot(normalizedWorkspaceRoot)
      || (threadId ? sessionStore.findBindingForThreadId(threadId) : null);
    if (binding?.bindingKey) {
      const params = sessionStore.getRuntimeParamsForWorkspace(binding.bindingKey, normalizedWorkspaceRoot);
      const storedModel = normalizeText(params?.model);
      if (storedModel) {
        return storedModel;
      }
    }
    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (existingClient?.model) {
      return normalizeText(existingClient.model);
    }
    return configuredModel;
  }

  function resolveWorkspaceEffort(workspaceRoot, { threadId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
    const pendingEffort = normalizeEffort(pendingEffortByWorkspaceRoot.get(normalizedWorkspaceRoot));
    if (pendingEffort) {
      return pendingEffort;
    }
    const binding = findBindingForWorkspaceRoot(normalizedWorkspaceRoot)
      || (threadId ? sessionStore.findBindingForThreadId(threadId) : null);
    if (binding?.bindingKey) {
      const params = sessionStore.getRuntimeParamsForWorkspace(binding.bindingKey, normalizedWorkspaceRoot);
      const storedEffort = normalizeEffort(params?.reasoningEffort);
      if (storedEffort) {
        return storedEffort;
      }
    }
    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (existingClient?.effort) {
      return normalizeEffort(existingClient.effort);
    }
    return configuredEffort;
  }

  function rememberWorkspaceModel(workspaceRoot, model, effort = "") {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
    const rawEffort = normalizeEffort(effort) || resolveWorkspaceEffort(normalizedWorkspaceRoot);
    const resolved = resolveGeminiModelAndEffort(model, rawEffort);
    const normalizedModel = resolved.model;
    const normalizedEffort = resolved.effort;
    if (!normalizedWorkspaceRoot || !normalizedModel) {
      return;
    }
    pendingModelByWorkspaceRoot.set(normalizedWorkspaceRoot, normalizedModel);
    if (normalizedEffort) {
      pendingEffortByWorkspaceRoot.set(normalizedWorkspaceRoot, normalizedEffort);
    }
    const binding = findBindingForWorkspaceRoot(normalizedWorkspaceRoot);
    if (binding?.bindingKey) {
      sessionStore.setRuntimeParamsForWorkspace(binding.bindingKey, normalizedWorkspaceRoot, {
        model: normalizedModel,
        ...(normalizedEffort ? { reasoningEffort: normalizedEffort } : {}),
      });
    }
  }

  return {
    describe() {
      return {
        id: "gemini",
        kind: "runtime",
        command: config.geminiCommand || "agy",
        model: configuredModel,
        effort: configuredEffort,
        sessionsFile: config.sessionsFile,
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities() {
      return {
        nativeImageInput: false,
        toolImageRead: true,
      };
    },
    getCapabilities({ workspaceRoot = config.workspaceRoot, threadId = "" } = {}) {
      return {
        supportsModelListing: true,
        supportsThreadListing: true,
        supportsThreadResume: true,
        supportsCompact: false,
        supportsReasoningEffort: true,
        supportsImageFileRead: true,
        contextWindowTokens: config.geminiContextWindow,
      };
    },
    async initialize() {
      sessionStore.setAvailableModelCatalog(GEMINI_MODELS);
      ensureGeminiMcpConfig({
        workspaceRoot: config.workspaceRoot,
        cyberbossHome: process.env.CYBERBOSS_HOME,
        stateDir: config.stateDir,
        geminiConfigDir: config.geminiConfigDir,
        latentEnabled: config.latentEnabled,
        latentPythonCommand: config.latentPythonCommand,
        latentCorpusDir: config.latentCorpusDir,
        latentThreadsFile: config.latentThreadsFile,
      });
      return {
        mode: "gemini-cli",
        command: config.geminiCommand || "agy",
        model: configuredModel,
        effort: configuredEffort,
        models: GEMINI_MODELS,
      };
    },
    onEvent(listener) {
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
      const existing = clientsByWorkspace.get(normalizedWorkspaceRoot);
      if (existing) {
        existing.close();
        clientsByWorkspace.delete(normalizedWorkspaceRoot);
      }
      return { workspaceRoot: normalizedWorkspaceRoot };
    },
    async respondApproval() {
      // Gemini CLI runs with --dangerously-skip-permissions in headless companion mode
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const normalizedThreadId = normalizeThreadId(threadId);
      if (!normalizedThreadId) {
        throw new Error("A current thread is required before refreshing instructions.");
      }
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
      const resumed = await this.resumeThread({
        workspaceRoot: normalizedWorkspaceRoot,
        threadId: normalizedThreadId,
        model,
      });
      const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
      const refreshText = buildInstructionRefreshText(config);
      const { turnId } = client.sendUserMessage(refreshText, { threadId: resumed.threadId });
      return {
        threadId: resumed.threadId,
        turnId,
      };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "", effort = "" }) {
      const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || config.workspaceRoot;
      const existingThreadId = bindingKey
        ? normalizeThreadId(sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot))
        : "";
      const resolvedPair = resolveGeminiModelAndEffort(
        normalizeText(model) || resolveWorkspaceModel(normalizedWorkspaceRoot, { threadId: existingThreadId }) || configuredModel,
        normalizeEffort(effort) || resolveWorkspaceEffort(normalizedWorkspaceRoot, { threadId: existingThreadId }) || configuredEffort,
      );
      const effectiveModel = resolvedPair.model;
      const effectiveEffort = resolvedPair.effort;
      rememberWorkspaceModel(normalizedWorkspaceRoot, effectiveModel, effectiveEffort);

      let client = clientsByWorkspace.get(normalizedWorkspaceRoot);
      if (
        !client
        || !client.alive
        || (existingThreadId && client.getEffectiveSessionId() && client.getEffectiveSessionId() !== existingThreadId)
        || (client.model && client.model !== effectiveModel)
      ) {
        if (client) {
          client.close();
          clientsByWorkspace.delete(normalizedWorkspaceRoot);
        }
        client = getOrCreateClient(normalizedWorkspaceRoot, existingThreadId, {
          model: effectiveModel,
          effort: effectiveEffort,
        });
        await client.connect(existingThreadId);
      }

      const isFirstTurnForThread = !existingThreadId || !instructionsSentThreads.has(existingThreadId);
      const turnText = isFirstTurnForThread
        ? buildOpeningTurnText(config, text)
        : text;

      const { turnId } = client.sendUserMessage(turnText, { threadId: existingThreadId });
      let returnedThreadId = existingThreadId || client.getEffectiveSessionId();
      if (!isValidUuid(returnedThreadId)) {
        returnedThreadId = await client.waitForSessionId({ timeoutMs: GEMINI_INIT_SESSION_TIMEOUT_MS });
      }
      instructionsSentThreads.add(returnedThreadId);

      if (bindingKey && isValidUuid(returnedThreadId)) {
        sessionStore.setThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot, returnedThreadId, metadata);
        sessionStore.setRuntimeParamsForWorkspace(bindingKey, normalizedWorkspaceRoot, {
          model: effectiveModel,
          reasoningEffort: effectiveEffort,
        });
      }

      return {
        threadId: returnedThreadId,
        turnId,
      };
    },
    async ensureThread({ bindingKey, workspaceRoot, senderId, accountId }) {
      const existingThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (existingThreadId) {
        return { threadId: existingThreadId, created: false };
      }

      sessionStore.setActiveWorkspaceRoot(bindingKey, workspaceRoot);
      const created = await this.startNewThread({ workspaceRoot });
      if (created.threadId) {
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, created.threadId, { senderId, accountId });
      }
      return { threadId: created.threadId, created: true };
    },
    async startNewThread({ workspaceRoot, model = "", effort = "" }) {
      const existing = clientsByWorkspace.get(workspaceRoot);
      if (existing) {
        existing.close();
        clientsByWorkspace.delete(workspaceRoot);
      }

      const resolvedPair = resolveGeminiModelAndEffort(
        normalizeText(model) || resolveWorkspaceModel(workspaceRoot) || configuredModel,
        normalizeEffort(effort) || resolveWorkspaceEffort(workspaceRoot) || configuredEffort,
      );
      const effectiveModel = resolvedPair.model;
      const effectiveEffort = resolvedPair.effort;
      rememberWorkspaceModel(workspaceRoot, effectiveModel, effectiveEffort);

      const client = getOrCreateClient(workspaceRoot, "", {
        model: effectiveModel,
        effort: effectiveEffort,
      });
      await client.connect("");

      let threadId = "";
      try {
        threadId = await client.waitForSessionId({ timeoutMs: 1500 });
      } catch {
        threadId = client.getEffectiveSessionId();
      }
      if (isValidUuid(threadId)) {
        instructionsSentThreads.add(threadId);
      }
      return {
        threadId,
        model: effectiveModel,
        effort: effectiveEffort,
      };
    },
    async listThreads({ workspaceRoot }) {
      const convDirs = [
        path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"),
        path.join(os.homedir(), ".gemini", "antigravity", "conversations"),
      ];
      const seen = new Set();
      const items = [];
      for (const dir of convDirs) {
        if (!fs.existsSync(dir)) {
          continue;
        }
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const match = entry.name.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
            if (!match) {
              continue;
            }
            const id = match[1];
            if (seen.has(id)) {
              continue;
            }
            seen.add(id);
            const fullPath = path.join(dir, entry.name);
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(fullPath).mtimeMs;
            } catch {
              mtimeMs = 0;
            }
            items.push({
              id,
              name: id.slice(0, 8),
              updatedAt: Math.floor(mtimeMs / 1000),
            });
          }
        } catch {
          // ignore
        }
      }
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { data: items.slice(0, 15) };
    },
    async resumeThread({ workspaceRoot, threadId, model = "", effort = "" }) {
      const normalizedThreadId = normalizeThreadId(threadId);
      if (!normalizedThreadId) {
        throw new Error("threadId is required to resume a Gemini conversation.");
      }

      const existing = clientsByWorkspace.get(workspaceRoot);
      if (existing) {
        if (!model && !effort && existing.alive && existing.getEffectiveSessionId() === normalizedThreadId) {
          instructionsSentThreads.add(normalizedThreadId);
          return {
            threadId: normalizedThreadId,
            model: existing.model || resolveWorkspaceModel(workspaceRoot, { threadId: normalizedThreadId }),
          };
        }
        existing.close();
        clientsByWorkspace.delete(workspaceRoot);
      }

      const resolvedPair = resolveGeminiModelAndEffort(
        normalizeText(model) || resolveWorkspaceModel(workspaceRoot, { threadId: normalizedThreadId }) || configuredModel,
        normalizeEffort(effort) || resolveWorkspaceEffort(workspaceRoot, { threadId: normalizedThreadId }) || configuredEffort,
      );
      const effectiveModel = resolvedPair.model;
      const effectiveEffort = resolvedPair.effort;
      rememberWorkspaceModel(workspaceRoot, effectiveModel, effectiveEffort);

      const client = getOrCreateClient(workspaceRoot, normalizedThreadId, {
        model: effectiveModel,
        effort: effectiveEffort,
      });
      await client.connect(normalizedThreadId);
      instructionsSentThreads.add(normalizedThreadId);
      return {
        threadId: normalizedThreadId,
        model: effectiveModel,
        effort: effectiveEffort,
      };
    },
    async listModels() {
      return GEMINI_MODELS;
    },
    async setModel({ workspaceRoot, threadId, model }) {
      const normalizedInput = normalizeText(model).toLowerCase();
      let matchedEffort = resolveWorkspaceEffort(workspaceRoot, { threadId });
      const effortMatch = normalizedInput.match(/-(low|medium|high|xhigh)$/);
      if (effortMatch) {
        matchedEffort = effortMatch[1];
      }
      const resolvedPair = resolveGeminiModelAndEffort(normalizedInput, matchedEffort);
      const resolvedModel = resolvedPair.model;
      matchedEffort = resolvedPair.effort;
      rememberWorkspaceModel(workspaceRoot, resolvedModel, matchedEffort);
      if (threadId) {
        return this.resumeThread({ workspaceRoot, threadId, model: resolvedModel, effort: matchedEffort });
      }
      const existing = clientsByWorkspace.get(workspaceRoot);
      if (existing) {
        existing.close();
        clientsByWorkspace.delete(workspaceRoot);
      }
      return { threadId: "", model: resolvedModel, effort: matchedEffort };
    },
    async setReasoningEffort({ workspaceRoot, threadId, effort }) {
      const normalizedEffort = normalizeEffort(effort);
      if (!normalizedEffort) {
        throw new Error(`Unsupported reasoning effort: ${effort}. Choose low, medium, or high.`);
      }
      const currentModel = resolveWorkspaceModel(workspaceRoot, { threadId });
      const nextModel = resolveGeminiModelFlag(currentModel, normalizedEffort);
      rememberWorkspaceModel(workspaceRoot, nextModel, normalizedEffort);
      if (threadId) {
        return this.resumeThread({ workspaceRoot, threadId, model: nextModel, effort: normalizedEffort });
      }
      const existing = clientsByWorkspace.get(workspaceRoot);
      if (existing) {
        existing.close();
        clientsByWorkspace.delete(workspaceRoot);
      }
      return { threadId: "", model: nextModel, effort: normalizedEffort };
    },
    async sendMessage({ threadId, text, workspaceRoot = config.workspaceRoot, model = "", effort = "" }) {
      let client = clientsByWorkspace.get(workspaceRoot);
      const resolvedPair = resolveGeminiModelAndEffort(
        normalizeText(model) || resolveWorkspaceModel(workspaceRoot, { threadId }) || configuredModel,
        normalizeEffort(effort) || resolveWorkspaceEffort(workspaceRoot, { threadId }) || configuredEffort,
      );
      const effectiveModel = resolvedPair.model;
      const effectiveEffort = resolvedPair.effort;
      rememberWorkspaceModel(workspaceRoot, effectiveModel, effectiveEffort);

      if (!client || !client.alive) {
        client = getOrCreateClient(workspaceRoot, threadId, {
          model: effectiveModel,
          effort: effectiveEffort,
        });
        await client.connect(threadId);
      }

      const effectiveThreadId = client.getEffectiveSessionId() || normalizeThreadId(threadId);
      const shouldInjectOpeningInstructions = !effectiveThreadId || !instructionsSentThreads.has(effectiveThreadId);
      const turnText = shouldInjectOpeningInstructions
        ? buildOpeningTurnText(config, text)
        : text;

      if (effectiveThreadId) {
        instructionsSentThreads.add(effectiveThreadId);
      }

      const result = client.sendUserMessage(turnText, { threadId: effectiveThreadId });
      return { turnId: result.turnId };
    },
    async compactThread() {
      throw new Error("Context compaction is managed automatically by Gemini CLI.");
    },
    async cancelTurn({ workspaceRoot = config.workspaceRoot } = {}) {
      const client = clientsByWorkspace.get(workspaceRoot);
      if (client) {
        client.cancelTurn();
      }
    },
    async respondToApproval() {
      // Gemini CLI runs with --dangerously-skip-permissions in headless companion mode
    },
    async close() {
      for (const client of clientsByWorkspace.values()) {
        client.close();
      }
      clientsByWorkspace.clear();
    },
  };
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function normalizeThreadId(value) {
  const normalized = normalizeText(value);
  return isValidUuid(normalized) ? normalized : "";
}

function normalizeEffort(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["low", "medium", "high", "xhigh"].includes(normalized) ? normalized : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  createGeminiRuntimeAdapter,
  GEMINI_MODELS,
};
