const fs = require("fs");
const os = require("os");
const path = require("path");

function ensureClaudeProjectMcpConfig({
  workspaceRoot,
  cyberbossHome = "",
  stateDir = "",
  latentEnabled = true,
  latentPythonCommand = "",
  latentCorpusDir = "",
  latentThreadsFile = "",
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Claude project tools.");
  }

  const configPath = path.join(normalizedWorkspaceRoot, ".mcp.json");
  const current = readJsonObject(configPath);
  const latentConfig = buildClaudeLatentMcpServerConfig({
    cyberbossHome,
    stateDir,
    latentEnabled,
    latentPythonCommand,
    latentCorpusDir,
    latentThreadsFile,
  });
  const mcpServers = {
    ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
    cyberboss_tools: buildClaudeProjectMcpServerConfig({
      workspaceRoot: normalizedWorkspaceRoot,
      cyberbossHome,
    }),
  };
  if (latentConfig) {
    mcpServers.latent_memory = latentConfig;
  }
  const next = {
    ...current,
    mcpServers,
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath,
    serverName: "cyberboss_tools",
    config: next,
  };
}

function buildClaudeProjectMcpServerConfig({ workspaceRoot, cyberbossHome = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const home = normalizeText(cyberbossHome) || process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cyberboss MCP entrypoint not found: ${scriptPath}`);
  }
  return {
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "claudecode", "--workspace-root", normalizedWorkspaceRoot],
  };
}

function buildClaudeLatentMcpServerConfig({
  cyberbossHome = "",
  stateDir = "",
  latentEnabled = true,
  latentPythonCommand = "",
  latentCorpusDir = "",
  latentThreadsFile = "",
} = {}) {
  const envFlag = normalizeText(process.env.CYBERBOSS_ENABLE_LATENT_MEMORY).toLowerCase();
  if (latentEnabled === false || envFlag === "0" || envFlag === "false" || envFlag === "no" || envFlag === "off") {
    return null;
  }
  const home = normalizeText(cyberbossHome) || process.env.CYBERBOSS_HOME || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "vendor", "Latent-memory", "src", "mcp_server.py");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const resolvedStateDir = normalizeText(stateDir)
    || normalizeText(process.env.CYBERBOSS_STATE_DIR)
    || path.join(os.homedir(), ".cyberboss");
  const corpusDir = normalizeText(latentCorpusDir)
    || normalizeText(process.env.CYBERBOSS_LATENT_CORPUS_DIR)
    || path.join(resolvedStateDir, "latent", "memory");
  const threadsFile = normalizeText(latentThreadsFile)
    || normalizeText(process.env.CYBERBOSS_LATENT_THREADS_FILE)
    || path.join(resolvedStateDir, "latent", "threads.jsonl");
  const pythonCmd = normalizeText(latentPythonCommand)
    || normalizeText(process.env.CYBERBOSS_LATENT_PYTHON)
    || (process.platform === "win32" ? "python" : "python3");

  try {
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.mkdirSync(path.dirname(threadsFile), { recursive: true });
  } catch {
    // ignore mkdir errors in read-only test sandboxes
  }

  return {
    command: pythonCmd,
    args: [scriptPath, "--corpus", corpusDir, "--threads", threadsFile, "--timezone", "Asia/Shanghai"],
  };
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
  buildClaudeLatentMcpServerConfig,
};
