#!/usr/bin/env bash
# GhostBus one-shot VPS setup — Ubuntu 22.04/24.04, run as root (or sudo).
# Installs Docker, clones the public repo, generates an admin key, builds and
# runs the hosted server with a persistent volume and restart policy.
#
#   curl -fsSL https://raw.githubusercontent.com/littlestjames82-sys/ghostbus/main/deploy/docker/vps-setup.sh | sudo bash
#
# The admin key is printed ONCE at the end and stored root-only on the box at
# /root/ghostbus-admin-key. Put a reverse proxy (Caddy/nginx) with HTTPS in
# front for production; the app itself serves on :8388.
set -euo pipefail

if [ "$(id -u)" != "0" ]; then echo "run as root (sudo bash)"; exit 1; fi

echo "== installing docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "== fetching ghostbus =="
if [ ! -d /opt/ghostbus ]; then
  apt-get update -qq && apt-get install -y -qq git >/dev/null
  git clone --depth 1 https://github.com/littlestjames82-sys/ghostbus /opt/ghostbus
else
  git -C /opt/ghostbus pull --ff-only
fi

echo "== admin key =="
if [ ! -f /root/ghostbus-admin-key ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > /root/ghostbus-admin-key
  chmod 600 /root/ghostbus-admin-key
fi
ADMIN_KEY=$(cat /root/ghostbus-admin-key)

echo "== build + run =="
docker build -t ghostbus-hosted -f /opt/ghostbus/deploy/docker/Dockerfile /opt/ghostbus
docker rm -f ghostbus >/dev/null 2>&1 || true
docker run -d --name ghostbus --restart unless-stopped \
  -p 8388:8388 \
  -e GHOSTBUS_ADMIN_KEY="$ADMIN_KEY" \
  -e GHOSTBUS_PORT=8388 -e GHOSTBUS_DATA_DIR=/data \
  -v ghostbus-data:/data \
  ghostbus-hosted

echo "== waiting for health =="
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8388/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -s http://127.0.0.1:8388/health; echo

cat <<EOF

==================================================================
GhostBus hosted is running on this VPS, port 8388.

ADMIN KEY (also stored root-only at /root/ghostbus-admin-key):
  $ADMIN_KEY

Create your first workspace:
  curl -X POST http://<server-ip>:8388/api/workspaces \\
    -H 'x-bus-key: $ADMIN_KEY' -H 'content-type: application/json' \\
    -d '{"id":"studio","name":"Ghost Developer Studio"}'
  -> returns that workspace's own key (shown once). Board: /w/studio/

Next steps for production: point a domain at this box and put Caddy or
nginx with HTTPS in front of :8388, and restrict 8388 to localhost.
==================================================================
EOF
