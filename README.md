# Cyberboss Companion Stack

一个常驻在云服务器（VPS）上的个人编码与生活陪伴 Agent 系统。将微信双向通信、主动查岗与定时提醒、每日结构化时间轴看板（Timeline）以及四层长期记忆（Latent Memory）深度整合，支持 Gemini 客户端（`agy`）、Codex CLI 与 Claude Code 多运行时切换。

## 核心特性

- **微信双向桥接与多媒体交互**：支持文字、图片、语音、文件与表情包收发，针对微信对话体验进行了单条聚合投递与防刷屏优化。
- **时间感知与主动督促（Random Check-in & Reminder）**：
  - 每条消息自动注入精确时间戳与相隔时长感知。
  - 内置非阻塞定时提醒队列（`schedule_reminder`）与随机窗口主动查岗（`--checkin`），在不打扰休息/工作的前提下主动关心进度与状态。
- **每日时间轴追踪与无头截图（Timeline）**：
  - 自动从日常对话中归纳结构化时间块（JSON），维护个人作息与工作分类体系。
  - 支持一键生成可视化日程看板，并通过 Chromium 无头浏览器渲染高清长图直接发回微信。
- **四层长期记忆与山屋可视化（Latent Memory）**：
  - 自动挂载 8 个 `latent_*` MCP 工具（`latent_session_start`、`latent_search`、`latent_append`、`latent_supersede`、`latent_correct`、`latent_cleanup`、`latent_unresolved`、`latent_thread_close`）。
  - 涵盖「人格设定 + 纪实记忆库 + 未解决事项清单 + 跨会话线索快照」四层记忆结构，自带只读 Web 可视化面板（「山屋」）。
- **高可用多模型运行时**：
  - 原生支持 Gemini 客户端（`agy`）、Codex（`app-server`）与 Claude Code。
  - Gemini 运行时内置多模型容量故障转移链（`gemini-4-hydrogen-medium` -> `gemini-4-neon-low` -> `gemini-4-argon-low` -> `gemini-4-hydrogen-low`），自动屏蔽上游瞬时 `503 No capacity available` 报错并无感重试。

## 目录结构

```text
.
├── bin/                    # CLI 入口 (cyberboss)
├── deploy/gcp/             # Linux / GCP VPS 一键部署脚本与 systemd 服务单元
├── scripts/                # Tmux 共享会话与表情包处理脚本
├── src/
│   ├── adapters/
│   │   ├── channel/weixin/ # 微信通道适配器
│   │   └── runtime/        # Gemini / Codex / Claude Code 运行时适配器
│   ├── app/                # 随机主动查岗轮询器
│   ├── core/               # 核心调度、流式聚合投递与状态管理
│   ├── integrations/       # Timeline 时间轴集成
│   ├── services/           # 日记、提醒、表情包、视觉识别、时间轴服务
│   └── tools/              # 内置 MCP 工具宿主与 stdio 服务
├── templates/              # 微信人格与四层记忆操作协议模板
└── vendor/
    ├── Latent-memory/      # 四层长期记忆 MCP 服务端与山屋前端
    ├── timeline-for-agent/ # 每日时间块追踪与看板生成引擎
    └── whereabouts-mcp/    # 位置上下文与停留检测 MCP 组件
```

## 快速开始（Linux / Ubuntu / Debian VPS）

### 1. 一键安装依赖与系统服务

```bash
git clone <your-repo-url> ~/cyberboss-companion-stack
cd ~/cyberboss-companion-stack
bash deploy/gcp/install-gcp.sh
```

安装脚本会自动完成：
1. 安装 Node.js 22、Python 3、Chromium（用于时间轴截图）、`tmux` 及中文字体；
2. 安装项目依赖并全局链接 `timeline-for-agent`；
3. 初始化 `~/.cyberboss/latent/memory` 四层记忆库与访问密钥；
4. 生成 `~/.cyberboss/.env` 默认配置，并注册 `cyberboss-companion.service` 与 `latent-hut.service` 两个 `systemd` 守护服务。

### 2. 配置运行时与环境变量

编辑 `~/.cyberboss/.env`（可参考根目录 `.env.example`）：

```dotenv
CYBERBOSS_USER_NAME=你的称呼
CYBERBOSS_USER_GENDER=female
CYBERBOSS_CHANNEL=weixin
CYBERBOSS_RUNTIME=gemini
CYBERBOSS_ENABLE_CHECKIN=true
CYBERBOSS_ENABLE_LATENT_MEMORY=true

# Gemini 客户端配置
CYBERBOSS_GEMINI_COMMAND=agy
CYBERBOSS_GEMINI_MODEL=gemini-4-hydrogen-medium
CYBERBOSS_GEMINI_EFFORT=medium
```

### 3. 扫码登录微信并启动常驻服务

```bash
cd ~/cyberboss-companion-stack
npm run login
sudo systemctl restart cyberboss-companion.service
```

检查运行状态与实时日志：

```bash
npm run doctor
sudo journalctl -u cyberboss-companion.service -f
```

## 微信端常用命令

| 命令 | 说明 |
| :--- | :--- |
| `/help` | 查看当前通道支持的命令列表 |
| `/status` | 查看当前绑定的工作区、运行时模型、线程 ID 与上下文用量 |
| `/model` | 查看或切换当前会话使用的模型（如 `/model gemini-4-hydrogen-medium`） |
| `/new` | 开启全新的对话线程（自动通过 `latent_session_start` 继承长期记忆与未完线索） |
| `/compact` | 压缩当前会话上下文 |
| `/bind <path>` | 将当前微信会话绑定到指定工作区目录 |

## 本地安全访问「山屋」与「时间轴看板」

所有 Web 可视化服务默认仅监听 `127.0.0.1` 回环地址，不在公网暴露端口。在本地电脑通过 SSH 端口转发即可安全访问：

```bash
ssh -L 8766:127.0.0.1:8766 -L 4319:127.0.0.1:4319 <user>@<your-vps-ip>
```

- **Latent 山屋可视化面板**：浏览器访问 `http://127.0.0.1:8766/hut/`，输入 VPS 上 `~/.cyberboss/latent/hut.token` 中的密钥即可查看四层记忆与会话线索。
- **Timeline 每日时间轴看板**：在 VPS 上运行 `timeline-for-agent serve --data ~/.cyberboss/timeline --port 4319` 后，浏览器访问 `http://127.0.0.1:4319`。

## 开发与自检

```bash
# 语法与模块完整性检查
npm run check

# Latent 记忆服务自检
python3 vendor/Latent-memory/src/mcp_server.py --selftest
```

## 开源协议

本项目采用 [AGPL-3.0](LICENSE) 协议开源。
