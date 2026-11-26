#!/usr/bin/env bash
# GhostBus one-shot VPS setup — Ubuntu 22.04/24.04, run as root (or sudo).
# Installs Docker, clones the public repo, generates an admin key, builds and
# runs the hosted server with a persistent volume and restart policy.
#
#   curl -fsSL https://raw.githubusercontent.com/littlestjames82-sys/ghostbus/main/deploy/docker/vps-setup.sh | sudo bash
#
# Production mode — recommended: give it a domain and it also installs
# Caddy (automatic HTTPS), binds the app to localhost only, and opens the
# firewall for SSH + HTTP/HTTPS only:
#
#   GHOSTBUS_DOMAIN=bus.example.com curl -fsSL ... | sudo bash
#   (equivalently: GHOSTBUS_DOMAIN=bus.example.com sudo bash vps-setup.sh)
#
# Without a domain the app is exposed directly on :8388 over plain HTTP —
# fine for a first look, NOT for production: workspace keys and agent
# tokens would cross the network in the clear.
#
# Also installed either way: /usr/local/bin/ghostbus-backup (nightly via
# cron, tarballs of the data volume in /root/ghostbus-backups, 14 kept).
#
# The admin key is printed ONCE at the end and stored root-only on the box at
# /root/ghostbus-admin-key.
set -euo pipefail

if [ "$(id -u)" != "0" ]; then echo "run as root (sudo bash)"; exit 1; fi
DOMAIN="${GHOSTBUS_DOMAIN:-}"
WORKERS="${GHOSTBUS_WORKERS:-1}"

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
if [ -n "$DOMAIN" ]; then
  PUBLISH="127.0.0.1:8388:8388"   # Caddy terminates TLS in front
else
  PUBLISH="8388:8388"
fi
docker run -d --name ghostbus --restart unless-stopped \
  -p "$PUBLISH" \
  -e GHOSTBUS_ADMIN_KEY="$ADMIN_KEY" \
  -e GHOSTBUS_PORT=8388 -e GHOSTBUS_DATA_DIR=/data \
  -e GHOSTBUS_WORKERS="$WORKERS" \
  -v ghostbus-data:/data \
  ghostbus-hosted

echo "== waiting for health =="
healthy=""
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8388/health >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo "ERROR: ghostbus did not become healthy in 30s — last container logs:" >&2
  docker logs --tail 50 ghostbus >&2 || true
  exit 1
fi
curl -s http://127.0.0.1:8388/health; echo

echo "== nightly backup =="
cat > /usr/local/bin/ghostbus-backup <<'EOS'
#!/usr/bin/env bash
# Tar the ghostbus-data volume (registry + workspace snapshots/journals).
set -euo pipefail
mkdir -p /root/ghostbus-backups
stamp=$(date +%Y%m%d-%H%M%S)
docker run --rm -v ghostbus-data:/data:ro -v /root/ghostbus-backups:/backup alpine \
  tar czf "/backup/ghostbus-$stamp.tgz" -C /data .
ls -1t /root/ghostbus-backups/ghostbus-*.tgz | tail -n +15 | xargs -r rm -f
EOS
chmod 755 /usr/local/bin/ghostbus-backup
echo "17 3 * * * root /usr/local/bin/ghostbus-backup >/dev/null 2>&1" > /etc/cron.d/ghostbus-backup

if [ -n "$DOMAIN" ]; then
  echo "== caddy (HTTPS for $DOMAIN) =="
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:8388
}
EOF
  systemctl enable --now caddy
  systemctl reload caddy || systemctl restart caddy
fi

if command -v ufw >/dev/null 2>&1; then
  echo "== firewall =="
  ufw allow OpenSSH >/dev/null || ufw allow 22/tcp >/dev/null
  if [ -n "$DOMAIN" ]; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  else
    ufw allow 8388/tcp >/dev/null
  fi
  ufw --force enable >/dev/null
fi

cat <<EOF

==================================================================
GhostBus hosted is running on this VPS.
$(if [ -n "$DOMAIN" ]; then echo "Public URL: https://$DOMAIN  (app bound to localhost, Caddy serves HTTPS)"; else echo "URL: http://<server-ip>:8388  (PLAIN HTTP — set GHOSTBUS_DOMAIN and re-run for production HTTPS)"; fi)

ADMIN KEY (also stored root-only at /root/ghostbus-admin-key):
  $ADMIN_KEY

Create your first workspace:
  curl -X POST http${DOMAIN:+s}://${DOMAIN:-<server-ip>:8388}/api/workspaces \\
    -H 'x-bus-key: $ADMIN_KEY' -H 'content-type: application/json' \\
    -d '{"id":"studio","name":"Ghost Developer Studio"}'
  -> returns that workspace's own key (shown once). Board: /w/studio/

Backups: nightly to /root/ghostbus-backups (14 kept).
Operator runbook: /opt/ghostbus/deploy/docker/RUNBOOK.md
==================================================================
EOF
