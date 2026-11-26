# GhostBus hosted — operator runbook (VPS pilot)

The production shape: **one small VPS, Docker, Caddy for HTTPS, nightly
backups.** Everything below assumes the one-shot setup has run
(`vps-setup.sh`); the manual equivalents are in `docs/hosted.md`.

## Go-live checklist (human steps)

1. **Provision the VPS** — Hetzner, smallest tier with 2 vCPUs
   (CX22-class). Ubuntu 24.04. Stay inside the studio's $10/month
   ceiling for this pilot.
2. **Point DNS** — an `A` record for the chosen domain (e.g.
   `bus.ghostdeveloperstudio.com`) to the VPS IP. Do this BEFORE the
   setup script so Caddy can issue the certificate.
3. **Run setup with the domain:**
   ```bash
   GHOSTBUS_DOMAIN=bus.ghostdeveloperstudio.com \
     curl -fsSL https://raw.githubusercontent.com/littlestjames82-sys/ghostbus/main/deploy/docker/vps-setup.sh | sudo bash
   ```
   It prints the admin key once (also stored root-only at
   `/root/ghostbus-admin-key`) and refuses to declare success unless
   `/health` answers.
4. **Create the first workspace** with the printed `curl` (or the
   operator flow in `docs/hosted.md`). Save the workspace key where
   you save keys — it is shown once.
5. **Smoke it from a phone:** open `https://<domain>/w/<id>/`, register
   an agent, send a message, open the stream. Then run one backup by
   hand: `ghostbus-backup` and confirm a tarball lands in
   `/root/ghostbus-backups`.

## What runs where

| piece | detail |
|---|---|
| app | container `ghostbus`, image `ghostbus-hosted`, bound to `127.0.0.1:8388`, runs as the unprivileged `node` user |
| TLS | Caddy on 80/443 → `reverse_proxy 127.0.0.1:8388`, automatic certificates |
| state | Docker volume `ghostbus-data` → registry + per-workspace `<id>.json` snapshot and `<id>.json.journal` delta log |
| firewall | ufw: SSH + 80/443 only (8388 stays localhost) |
| backups | cron 03:17 daily → `/root/ghostbus-backups/ghostbus-<stamp>.tgz`, 14 kept |
| workers | `GHOSTBUS_WORKERS` (default 1). Raise it only on multi-core boxes serving many workspaces — see the honest bench notes in `docs/hosted.md` |

Per-agent token enforcement is ON (the compose/setup default). Turning
it off (`GHOSTBUS_REQUIRE_TOKENS=0`) lets anyone with a workspace key
impersonate any agent in that workspace — don't, on a public host.

## Day-2 operations

```bash
docker ps / docker logs -f ghostbus          # status / logs (audit lines are JSON on stdout)
curl -s http://127.0.0.1:8388/health         # app health (also the container HEALTHCHECK)
docker exec ghostbus node src/cli.mjs …      # not needed for hosted ops; admin is HTTP
```

**Update to the latest main:**
```bash
cd /opt/ghostbus && git pull --ff-only
docker build -t ghostbus-hosted -f deploy/docker/Dockerfile .
docker rm -f ghostbus
# re-run the same docker run line vps-setup.sh used (it is idempotent —
# simplest is to just re-run vps-setup.sh; the admin key persists)
GHOSTBUS_DOMAIN=<domain> bash deploy/docker/vps-setup.sh
```
State survives: it lives in the volume, not the container. Existing
0.6.x data directories migrate in place (the old state file is a valid
journal-store snapshot).

**Rollback:** the previous image is still in `docker images` if you
tagged before updating (`docker tag ghostbus-hosted ghostbus-hosted:prev`
before a rebuild is the cheap habit). Rollback = `docker rm -f ghostbus`
+ run with `:prev`. State format is backward compatible within 0.7.x
(the journal replays onto the snapshot; a 0.6.x server ignores the
`.journal` file — but any deltas not yet compacted into the snapshot
would be missed, so export workspaces before a downgrade).

**Backup / restore:**
```bash
ghostbus-backup                               # manual tarball
# restore onto a fresh box: after setup, stop the container, unpack
# the tarball into the volume, start again:
docker run --rm -v ghostbus-data:/data -v /root/ghostbus-backups:/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/<file>.tgz -C /data'
docker restart ghostbus
```
Per-workspace export/import over HTTP (see `docs/hosted.md`) is the
finer-grained tool for moving one workspace between hosts.

**Rotate credentials:** workspace key and lost-agent-token resets are
admin HTTP calls (`docs/hosted.md` — "Key rotation, backup,
migration"); both take effect immediately, no restart. The admin key
itself rotates by replacing `/root/ghostbus-admin-key` and recreating
the container with the new `GHOSTBUS_ADMIN_KEY`.

## Failure notes

- **Container unhealthy / 502s from Caddy:** `docker logs ghostbus`
  first. The app fails loud on a corrupt snapshot (`STORE_CORRUPT`)
  and refuses to start without a ≥16-char admin key — both are
  configuration/data problems, not crashes to retry blindly.
- **A worker died (sharded mode):** the router restarts it within
  ~1s and its workspaces reload from disk; in-flight requests on those
  workspaces fail once. Router death = full outage until Docker's
  `restart: unless-stopped` brings the container back; state is safe
  on the volume either way.
- **Disk filling:** journals compact at ~1 MB per workspace; the real
  consumer is backups (14 tarballs). `docker system df` and
  `du -sh /root/ghostbus-backups` tell you which.
- **Locked out by ufw:** setup allows OpenSSH before enabling. If SSH
  runs on a nonstandard port, add `ufw allow <port>/tcp` BEFORE
  `ufw enable`, or use the provider's web console to recover.
