const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
  buildClaudeLatentMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");
const {
  buildCodexMcpConfigArgs,
  resolveCodexMcpServerConfigs,
} = require("../src/adapters/runtime/codex/mcp-config");

test("ensureClaudeProjectMcpConfig upserts cyberboss MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});

test("ensureClaudeProjectMcpConfig and resolveCodexMcpServerConfigs mount latent_memory when vendor script exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-latent-mcp-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const stateDir = path.join(root, "state");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "vendor", "Latent-memory", "src"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(path.join(cyberbossHome, "vendor", "Latent-memory", "src", "mcp_server.py"), "#!/usr/bin/env python3\n", "utf8");

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome, stateDir });
  const saved = JSON.parse(fs.readFileSync(result.configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.latent_memory, buildClaudeLatentMcpServerConfig({
    cyberbossHome,
    stateDir,
  }));

  const codexServers = resolveCodexMcpServerConfigs({ cyberbossHome, stateDir });
  assert.equal(codexServers.length, 2);
  assert.equal(codexServers[0].name, "cyberboss_tools");
  assert.equal(codexServers[1].name, "latent_memory");

  const args = buildCodexMcpConfigArgs(codexServers);
  assert.ok(args.includes("mcp_servers.latent_memory.tools.latent_session_start.approval_mode=\"auto\""));
  assert.ok(args.includes("mcp_servers.latent_memory.tools.latent_search.approval_mode=\"auto\""));
});

test("ensureClaudeProjectMcpConfig rewrites stale cyberboss MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const cyberbossHome = path.join(root, "cyberboss-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(cyberbossHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(cyberbossHome, "bin", "cyberboss.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      cyberboss_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, cyberbossHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.cyberboss_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    cyberbossHome,
  }));
});
