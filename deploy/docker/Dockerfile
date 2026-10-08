# GhostBus hosted server — one process, many workspaces.
#   docker build -t ghostbus-hosted -f deploy/docker/Dockerfile .
#   docker run -p 8388:8388 -e GHOSTBUS_ADMIN_KEY=<long-secret> -v ghostbus-data:/data ghostbus-hosted
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV GHOSTBUS_PORT=8388 GHOSTBUS_DATA_DIR=/data
EXPOSE 8388
VOLUME ["/data"]
CMD ["node", "src/hosted-server.mjs"]
