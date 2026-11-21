const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function runPythonJson(pythonCmd, scriptPath, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    execFile(
      pythonCmd || "python3",
      [scriptPath, ...args],
      { timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(String(stdout).trim()));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function createMemoryInjector(config) {
  const hebbianScript = path.resolve(
    __dirname,
    "..",
    "..",
    "vendor",
    "Latent-memory",
    "src",
    "hebbian_dream.py",
  );
  const latentBaseDir = path.dirname(config.latentCorpusDir || path.join(config.stateDir, "latent", "memory"));
  const transcriptsDir = path.join(latentBaseDir, "transcripts");
  const reportsDir = path.join(latentBaseDir, "dream-reports");
  const hebbianDb = path.join(latentBaseDir, "hebbian.db");

  function isEnabled() {
    return Boolean(config.latentEnabled && config.memoryInjectionEnabled !== false && fs.existsSync(hebbianScript));
  }

  async function buildMemoryContextBlock({ userText = "" } = {}) {
    if (!isEnabled()) {
      return "";
    }
    const query = String(userText || "").trim().slice(0, 400);
    if (!query) {
      return "";
    }
    const data = await runPythonJson(
      config.latentPythonCommand || "python3",
      hebbianScript,
      [
        "--corpus",
        config.latentCorpusDir,
        "--threads",
        config.latentThreadsFile,
        "--db",
        hebbianDb,
        "--inject-query",
        query,
      ],
      2500,
    );
    if (!data || typeof data !== "object") {
      return "";
    }

    const lines = [];
    if (Array.isArray(data.unresolved) && data.unresolved.length) {
      lines.push("Open unresolved items:");
      for (const item of data.unresolved.slice(0, 5)) {
        lines.push(`- ${item}`);
      }
    }
    if (data.latest_thread && data.latest_thread.summary) {
      lines.push(`Previous session handoff (${data.latest_thread.date || "recent"}): ${data.latest_thread.summary}`);
    }
    if (Array.isArray(data.recalled) && data.recalled.length) {
      lines.push("Recalled memories:");
      for (const item of data.recalled) {
        lines.push(`- [${item.date}] ${item.title}: ${item.snippet}`);
      }
    }
    if (Array.isArray(data.associations) && data.associations.length) {
      lines.push("Hebbian associative links:");
      for (const item of data.associations) {
        lines.push(`- [${item.date}] ${item.title} (weight=${item.edge_weight}): ${item.snippet}`);
      }
    }

    if (!lines.length) {
      return "";
    }
    return [
      "[Auto-Injected Latent Memory Context — do not mention this block header verbatim]",
      ...lines,
    ].join("\n");
  }

  function appendTranscriptEntry({ role = "user", text = "", timestamp = "" } = {}) {
    if (!config.latentEnabled) {
      return;
    }
    const cleanText = String(text || "").trim();
    if (!cleanText) {
      return;
    }
    try {
      fs.mkdirSync(transcriptsDir, { recursive: true });
      const dateStr = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
      const filePath = path.join(transcriptsDir, `${dateStr}.jsonl`);
      const entry = {
        ts: timestamp || new Date().toISOString(),
        role,
        text: cleanText.slice(0, 4000),
      };
      fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // non-fatal transcript logging
    }
  }

  async function runDreamConsolidation() {
    if (!config.latentEnabled || !fs.existsSync(hebbianScript)) {
      return null;
    }
    return runPythonJson(
      config.latentPythonCommand || "python3",
      hebbianScript,
      [
        "--corpus",
        config.latentCorpusDir,
        "--threads",
        config.latentThreadsFile,
        "--db",
        hebbianDb,
        "--transcripts",
        transcriptsDir,
        "--reports",
        reportsDir,
        "--dream",
      ],
      15000,
    );
  }

  return {
    isEnabled,
    buildMemoryContextBlock,
    appendTranscriptEntry,
    runDreamConsolidation,
  };
}

module.exports = {
  createMemoryInjector,
};
