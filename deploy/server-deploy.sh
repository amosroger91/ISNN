#!/bin/bash
# Production deploy for ISNN Overtime Desk. Install on the server as
# /opt/isnn/deploy.sh (chmod 700). Run it only through a GitHub Actions deploy
# key's forced command in /root/.ssh/authorized_keys, and keep it outside src/
# so that pushing to the repo cannot change what runs as root.
set -euo pipefail
exec 9>/tmp/isnn-deploy.lock
flock 9
cd /opt/isnn
git -C src fetch -q origin main
git -C src reset -q --hard origin/main
echo "Deploying $(git -C src log --oneline -1)"
docker compose up -d --build 2>&1 | grep -vE '^#[0-9]+ ' || true
docker image prune -f >/dev/null
docker builder prune -af >/dev/null
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4320/api/health; then
    echo
    echo "Healthy."
    exit 0
  fi
  sleep 2
done
echo "Health check failed." >&2
docker logs --tail 40 isnn >&2
exit 1
