#!/usr/bin/env bash
# 몽글 마을 서버 설치 (Ubuntu 24.04, 처음 한 번)
#   sudo bash setup.sh
# 하는 일: Node.js 22 설치 → /opt/mongle-village 에 코드 받기 → mongle 서비스 등록(꺼지면 저절로 다시 켜짐)
# 여러 번 돌려도 괜찮아요. 이미 된 단계는 건너뛰어요.
set -euo pipefail
REPO="${REPO:-https://github.com/hashinaoffice-hue/mongle-village.git}"
BRANCH="${BRANCH:-main}"
APP=/opt/mongle-village
DATA=/var/lib/mongle

[ "$(id -u)" = 0 ] || { echo "sudo bash setup.sh 로 실행해 주세요"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== 1/4 Node.js 22 =="
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null || apt-get install -y git
node -v

echo "== 2/4 코드 받기 =="
id mongle >/dev/null 2>&1 || useradd --system --home "$DATA" --create-home --shell /usr/sbin/nologin mongle
mkdir -p "$DATA" && chown mongle:mongle "$DATA"
if [ ! -d "$APP/.git" ]; then git clone --branch "$BRANCH" "$REPO" "$APP"; fi
cd "$APP"
git fetch origin "$BRANCH" && git reset --hard "origin/$BRANCH"
npm ci --omit=dev

echo "== 3/4 서비스 등록 =="
cat > /etc/systemd/system/mongle.service <<UNIT
[Unit]
Description=Mongle Village game server
After=network-online.target
Wants=network-online.target

[Service]
User=mongle
WorkingDirectory=$APP
Environment=NODE_ENV=production
Environment=PORT=8787
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=1
Environment=BAN_FILE=$DATA/bans.json
EnvironmentFile=-/etc/mongle.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2
LimitNOFILE=65536
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
UNIT
[ -f /etc/mongle.env ] || printf '# 몽글 마을 설정 (바꾼 뒤: sudo systemctl restart mongle)\n# XMAS=1\n# MAX_PLAYERS=2000\n' > /etc/mongle.env
systemctl daemon-reload
systemctl enable mongle >/dev/null
systemctl restart mongle

echo "== 4/4 확인 =="
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fs http://127.0.0.1:8787/api/channels >/dev/null; then echo "서버가 켜졌어요: http://127.0.0.1:8787"; exit 0; fi
  sleep 1
done
echo "서버가 켜지지 않았어요. 기록 보기: sudo journalctl -u mongle -n 50"; exit 1
