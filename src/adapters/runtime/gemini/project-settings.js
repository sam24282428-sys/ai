const fs = require("fs");
const os = require("os");
const path = require("path");
const { listLatentToolNames } = require("../codex/mcp-config");
const { listProjectToolNames } = require("../../../tools/tool-host");

function ensureGeminiMcpConfig({
  workspaceRoot,
  cyberbossHome = "",
  stateDir = "",
  geminiConfigDir = "",
  latentEnabled = true,
  latentPythonCommand = "",
  latentCorpusDir = "",
  latentThreadsFile = "",
} = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot) || process.cwd();
  const resolvedGeminiConfigDir = normalizeText(geminiConfigDir) || path.join(os.homedir(), ".gemini", "config");
  fs.mkdirSync(resolvedGeminiConfigDir, { recursive: true });

  const mcpConfigPath = path.join(resolvedGeminiConfigDir, "mcp_config.json");
  const current = readJsonObject(mcpConfigPath);

  const cyberbossServer = buildGeminiCyberbossMcpServerConfig({
    workspaceRoot: normalizedWorkspaceRoot,
    cyberbossHome,
  });
  const latentServer = buildGeminiLatentMcpServerConfig({
    cyberbossHome,
    stateDir,
    latentEnabled,
    latentPythonCommand,
    latentCorpusDir,
    latentThreadsFile,
  });

  const mcpServers = {
    ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
    cyberboss_tools: cyberbossServer,
  };
  if (latentServer) {
    mcpServers.latent_memory = latentServer;
  }

  const next = {
    ...current,
    mcpServers,
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(mcpConfigPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath: mcpConfigPath,
    serverName: "cyberboss_tools",
  };
}

function buildGeminiCyberbossMcpServerConfig({ workspaceRoot, cyberbossHome = "" }) {
  const resolvedHome = resolveCyberbossHome(cyberbossHome);
  const entryScript = path.join(resolvedHome, "bin", "cyberboss.js");
  const tools = {};
  for (const toolName of listProjectToolNames({ runtimeId: "gemini" })) {
    tools[toolName] = { eager: true };
  }
  return {
    command: process.execPath,
    args: [entryScript, "tool-mcp-server", "--runtime-id", "gemini", "--workspace-root", workspaceRoot],
    cwd: workspaceRoot,
    tools,
  };
}

function buildGeminiLatentMcpServerConfig({
  cyberbossHome = "",
  stateDir = "",
  latentEnabled = true,
  latentPythonCommand = "",
  latentCorpusDir = "",
  latentThreadsFile = "",
} = {}) {
  if (latentEnabled === false) {
    return null;
  }
  const resolvedHome = resolveCyberbossHome(cyberbossHome);
  const resolvedStateDir = normalizeText(stateDir) || path.join(os.homedir(), ".cyberboss");
  const entryScript = path.join(resolvedHome, "vendor", "Latent-memory", "src", "mcp_server.py");
  if (!fs.existsSync(entryScript)) {
    return null;
  }
  const pythonCmd = normalizeText(latentPythonCommand) || (process.platform === "win32" ? "python" : "python3");
  const corpusDir = normalizeText(latentCorpusDir) || path.join(resolvedStateDir, "latent", "memory");
  const threadsFile = normalizeText(latentThreadsFile) || path.join(resolvedStateDir, "latent", "threads.jsonl");
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(path.dirname(threadsFile), { recursive: true });
  const tools = {};
  for (const toolName of listLatentToolNames()) {
    tools[toolName] = { eager: true };
  }
  return {
    command: pythonCmd,
    args: [entryScript, "--corpus", corpusDir, "--threads", threadsFile, "--timezone", "Asia/Shanghai"],
    tools,
  };
}

function resolveCyberbossHome(cyberbossHome) {
  const normalized = normalizeText(cyberbossHome) || normalizeText(process.env.CYBERBOSS_HOME);
  if (normalized) {
    return path.resolve(normalized);
  }
  return path.resolve(__dirname, "../../../..");
}

function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ensureGeminiMcpConfig,
};
