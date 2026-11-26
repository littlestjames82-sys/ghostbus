# GhostBus hosted server — one process, many workspaces.
#   docker build -t ghostbus-hosted -f deploy/docker/Dockerfile .
#   docker run -p 8388:8388 -e GHOSTBUS_ADMIN_KEY=<long-secret> -v ghostbus-data:/data ghostbus-hosted
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
# Run as the image's unprivileged node user; /data is the state volume
# (registry + per-workspace snapshot/journal files). A named volume
# inherits this ownership on first use; for a bind mount, chown the
# host directory to 1000:1000.
RUN mkdir -p /data && chown node:node /data
ENV GHOSTBUS_PORT=8388 GHOSTBUS_DATA_DIR=/data
EXPOSE 8388
VOLUME ["/data"]
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8388/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/hosted-server.mjs"]
