#!/usr/bin/env bash
# 새 버전 올리기: GitHub main 의 최신 코드를 받아 서버를 다시 켜요
#   sudo bash /opt/mongle-village/deploy/update.sh
# 다시 켜는 순간 접속한 사람들은 채널 고르는 화면으로 돌아가요. 사람이 적은 시간에 해 주세요.
set -euo pipefail
cd /opt/mongle-village
git fetch origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then echo "이미 최신이에요"; exit 0; fi
git log --oneline HEAD..origin/main
git reset --hard origin/main
npm ci --omit=dev
systemctl restart mongle
sleep 2
curl -fs http://127.0.0.1:8787/api/stats && echo && echo "새 버전으로 켜졌어요"
