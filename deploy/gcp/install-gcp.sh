#!/usr/bin/env bash
set -euo pipefail

STACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GCP_USER="${SUDO_USER:-$(whoami)}"
USER_HOME="$(eval echo "~$GCP_USER")"
STATE_DIR="$USER_HOME/.cyberboss"
LATENT_DIR="$STATE_DIR/latent"

echo "==> [1/5] 安装 Ubuntu/Debian 基础依赖 (Node.js 22, Python3, Chromium, Tmux)..."
sudo apt-get update -y
sudo apt-get install -y curl git tmux python3 python3-pip python3-cryptography ca-certificates fonts-noto-cjk

if ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || true
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> [2/5] 安装项目依赖并全局链接本地 timeline-for-agent..."
sudo npm install -g "$STACK_DIR/vendor/timeline-for-agent"

echo "==> [3/5] 初始化 ~/.cyberboss 状态目录与 Latent 四层记忆库..."
mkdir -p "$STATE_DIR/logs" "$LATENT_DIR/memory"
touch "$LATENT_DIR/threads.jsonl"
if [ -z "$(ls -A "$LATENT_DIR/memory" 2>/dev/null || true)" ]; then
  cat > "$LATENT_DIR/memory/0000-00-00-bootstrap.md" <<'EOF'
## 2026-11-18 · 常驻陪伴体初始化 [record_id=bootstrap-0001]

完成常驻陪伴/督促体初始化部署，接入微信通道、时间轴追踪与四层长期记忆。
EOF
fi

if [ ! -f "$LATENT_DIR/mcp.token" ]; then
  python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$LATENT_DIR/mcp.token"
  chmod 600 "$LATENT_DIR/mcp.token"
fi
if [ ! -f "$LATENT_DIR/hut.token" ]; then
  python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$LATENT_DIR/hut.token"
  chmod 600 "$LATENT_DIR/hut.token"
fi

if [ ! -f "$STATE_DIR/.env" ]; then
  cp "$STACK_DIR/deploy/gcp/env.gcp.example" "$STATE_DIR/.env"
  echo "    已生成默认配置: $STATE_DIR/.env"
fi

if [ ! -f "$STATE_DIR/weixin-instructions.md" ]; then
  cp "$STACK_DIR/templates/weixin-instructions.md" "$STATE_DIR/weixin-instructions.md"
fi
if [ ! -f "$STATE_DIR/weixin-operations.md" ]; then
  cp "$STACK_DIR/templates/weixin-operations.md" "$STATE_DIR/weixin-operations.md"
fi

chown -R "$GCP_USER:$GCP_USER" "$STATE_DIR"
chmod +x "$STACK_DIR/deploy/gcp/tmux-attach.sh" "$STACK_DIR/bin/cyberboss.js"

echo "==> [4/5] 执行 Latent 显影与项目代码自检..."
python3 "$STACK_DIR/vendor/Latent-memory/src/mcp_server.py" --corpus "$LATENT_DIR/memory" --threads "$LATENT_DIR/threads.jsonl" --timezone Asia/Shanghai --doctor || true
cd "$STACK_DIR" && npm install
cd "$STACK_DIR" && npm run check

echo "==> [5/5] 安装并启动 Systemd 常驻服务 (latent-hut / cyberboss-companion)..."
for svc in latent-hut.service cyberboss-companion.service; do
  sed -e "s|__GCP_USER__|$GCP_USER|g" -e "s|__STACK_DIR__|$STACK_DIR|g" \
    "$STACK_DIR/deploy/gcp/systemd/$svc" | sudo tee "/etc/systemd/system/$svc" >/dev/null
done

sudo systemctl daemon-reload
sudo systemctl enable --now latent-hut.service
sudo systemctl enable cyberboss-companion.service

echo "==> 部署完成！下一步操作："
echo "1. 扫码登录微信（只需首次执行）："
echo "   cd $STACK_DIR && npm run login"
echo "2. 扫码成功后启动常驻陪伴与主动查岗服务："
echo "   sudo systemctl restart cyberboss-companion.service"
echo "3. 随时进入 Tmux 共享终端观察或接管会话："
echo "   $STACK_DIR/deploy/gcp/tmux-attach.sh"
echo "4. 查看山屋访问密钥："
echo "   cat $LATENT_DIR/hut.token"
