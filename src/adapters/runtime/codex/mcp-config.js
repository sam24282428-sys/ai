const fs = require("fs");
const os = require("os");
const path = require("path");
const { listProjectToolNames } = require("../../../tools/tool-host");

const LATENT_TOOL_NAMES = [
  "latent_search",
  "latent_session_start",
  "latent_append",
  "latent_supersede",
  "latent_correct",
  "latent_cleanup",
  "latent_unresolved",
  "latent_thread_close",
];

function listLatentToolNames() {
  return [...LATENT_TOOL_NAMES];
}

function resolveCodexProjectToolMcpServerConfig({ cyberbossHome = "" } = {}) {
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
    toolNames: listProjectToolNames(),
  };
}

function resolveLatentMcpServerConfig({
  cyberbossHome = "",
  stateDir = "",
  latentEnabled = true,
  latentPythonCommand = "",
  latentCorpusDir = "",
  latentThreadsFile = "",
} = {}) {
  const envFlag = normalizeNonEmptyString(process.env.CYBERBOSS_ENABLE_LATENT_MEMORY).toLowerCase();
  if (latentEnabled === false || envFlag === "0" || envFlag === "false" || envFlag === "no" || envFlag === "off") {
    return null;
  }
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "vendor", "Latent-memory", "src", "mcp_server.py");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const resolvedStateDir = normalizeNonEmptyString(stateDir)
    || normalizeNonEmptyString(process.env.CYBERBOSS_STATE_DIR)
    || path.join(os.homedir(), ".cyberboss");
  const corpusDir = normalizeNonEmptyString(latentCorpusDir)
    || normalizeNonEmptyString(process.env.CYBERBOSS_LATENT_CORPUS_DIR)
    || path.join(resolvedStateDir, "latent", "memory");
  const threadsFile = normalizeNonEmptyString(latentThreadsFile)
    || normalizeNonEmptyString(process.env.CYBERBOSS_LATENT_THREADS_FILE)
    || path.join(resolvedStateDir, "latent", "threads.jsonl");
  const pythonCmd = normalizeNonEmptyString(latentPythonCommand)
    || normalizeNonEmptyString(process.env.CYBERBOSS_LATENT_PYTHON)
    || (process.platform === "win32" ? "python" : "python3");

  try {
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.mkdirSync(path.dirname(threadsFile), { recursive: true });
  } catch {
    // ignore mkdir errors in read-only test sandboxes
  }

  return {
    name: "latent_memory",
    command: pythonCmd,
    args: [scriptPath, "--corpus", corpusDir, "--threads", threadsFile, "--timezone", "Asia/Shanghai"],
    toolNames: listLatentToolNames(),
  };
}

function resolveCodexMcpServerConfigs(options = {}) {
  const servers = [];
  const projectTools = resolveCodexProjectToolMcpServerConfig(options);
  if (projectTools) {
    servers.push(projectTools);
  }
  const latentTools = resolveLatentMcpServerConfig(options);
  if (latentTools) {
    servers.push(latentTools);
  }
  return servers;
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig) {
    return [];
  }
  if (Array.isArray(mcpServerConfig)) {
    return mcpServerConfig.flatMap((entry) => buildSingleCodexMcpConfigArgs(entry));
  }
  return buildSingleCodexMcpConfigArgs(mcpServerConfig);
}

function buildSingleCodexMcpConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
    return [];
  }
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "cyberboss_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = Array.isArray(mcpServerConfig.args)
    ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  if (!command) {
    return [];
  }
  const toolNames = Array.isArray(mcpServerConfig.toolNames) && mcpServerConfig.toolNames.length
    ? mcpServerConfig.toolNames
    : (name === "latent_memory" ? listLatentToolNames() : listProjectToolNames());
  const configArgs = [
    "-c",
    `mcp_servers.${name}.command=${quoteTomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${formatTomlArray(args)}`,
  ];
  for (const toolName of toolNames) {
    configArgs.push(
      "-c",
      `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  buildCodexMcpConfigArgs,
  listLatentToolNames,
  resolveCodexProjectToolMcpServerConfig,
  resolveLatentMcpServerConfig,
  resolveCodexMcpServerConfigs,
};
