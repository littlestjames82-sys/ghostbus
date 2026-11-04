# GhostBus MCP server (stdio), for directory checks (Glama and similar)
# and local runs. Zero-dependency Node server: it starts and answers
# introspection (initialize, tools/list) with nothing else installed.
# The store defaults to a scratch file in /tmp so a checker can run
# tools against a throwaway workspace; set GHOSTBUS_STORE to persist.
#
# This is the MCP server image. The hosted multi-workspace relay has
# its own image at deploy/docker/Dockerfile.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV GHOSTBUS_STORE=/tmp/ghostbus-data.json

CMD ["node", "src/mcp-server.mjs"]
