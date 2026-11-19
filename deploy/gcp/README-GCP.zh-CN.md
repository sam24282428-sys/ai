# 云服务器（GCP / Linux VPS）常驻陪伴与督促体部署手册

本项目将以下三大核心模块深度融合，打造运行在 Linux VPS 上的微信常驻陪伴与时间督促 Agent：

1. **Cyberboss 微信桥与主动督促引擎**：支持微信通道收发（文字、图片、语音、文件、表情包）、Gemini / Codex / Claude Code 多运行时切换、定时提醒（Reminder）与随机主动查岗（Random Check-in）。
2. **Timeline-for-Agent**：每日结构化时间块记录（JSON）、可视化看板生成与 Chromium 无头浏览器自动截图回传微信。
3. **Latent-memory（显影）**：四层长期记忆架构（人格设定 + 记忆库正文 + 未解决事项清单 + 跨窗口会话线索），自动挂载 8 个 `latent_*` MCP 工具，并提供「山屋」只读可视化面板。

## 一、 常用运维命令（在 VPS 上执行）

- **首次或重新扫码绑定微信**：
  ```bash
  cd ~/cyberboss-companion-stack
  npm run login
  sudo systemctl restart cyberboss-companion.service
  ```
- **查看系统体检状态（微信通道 + Agent 运行时 + Timeline + Latent 记忆库）**：
  ```bash
  cd ~/cyberboss-companion-stack
  npm run doctor
  ```
- **查看实时运行日志**：
  ```bash
  sudo journalctl -u cyberboss-companion.service -f
  ```
- **用 Tmux 随时观察或接管共享会话**：
  ```bash
  ~/cyberboss-companion-stack/deploy/gcp/tmux-attach.sh
  ```

## 二、 在本地电脑通过 SSH 安全查看「山屋」与「时间轴看板」

无需在云服务器放行公网端口，直接在本地电脑终端运行 SSH 本地端口转发：
```bash
ssh -L 8766:127.0.0.1:8766 -L 4319:127.0.0.1:4319 <your-user>@<your-vps-ip>
```
- **Latent 山屋可视化面板**：浏览器打开 `http://127.0.0.1:8766/hut/`，填入 VPS 上 `~/.cyberboss/latent/hut.token` 中的密钥即可进入。
- **Timeline 每日时间轴**：在 VPS 上执行 `timeline-for-agent serve --data ~/.cyberboss/timeline --port 4319` 后，浏览器打开 `http://127.0.0.1:4319`。
