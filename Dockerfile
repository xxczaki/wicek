FROM node:24.21.0-alpine AS base
COPY --from=ghcr.io/jdx/mise:2026.10.3 /usr/local/bin/mise /usr/local/bin/mise
ENV MISE_DATA_DIR=/opt/mise
ENV MISE_GLOBAL_CONFIG_FILE=/app/mise.toml
ENV PATH="/opt/mise/shims:$PATH"
WORKDIR /app
COPY mise.toml package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN mise install

FROM base AS deps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY src/ src/
COPY tsconfig.json esbuild.js ./
RUN node esbuild.js

FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM mitmproxy/mitmproxy:12.2.3 AS broker
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-client && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY broker/credentials.py broker/entrypoint.sh ./
ENV PYTHONUNBUFFERED=1
USER 1000
ENTRYPOINT ["/app/entrypoint.sh"]

FROM base
RUN apk add --no-cache bash openssh-client git curl jq sqlite

# Authenticate HTTPS git operations through gh (mounted at /usr/local/bin/gh
# at runtime), using GH_TOKEN. System-level so it survives pod restarts,
# unlike a per-user `gh auth setup-git`.
RUN git config --system credential."https://github.com".helper '' && \
    git config --system --add credential."https://github.com".helper '!/usr/local/bin/gh auth git-credential' && \
    git config --system credential."https://gist.github.com".helper '' && \
    git config --system --add credential."https://gist.github.com".helper '!/usr/local/bin/gh auth git-credential'

COPY --from=build /app/dist/ ./dist/
COPY --from=prod-deps /app/node_modules/ ./node_modules/
COPY package.json CLAUDE.md cron.json .mcp.json ./
COPY .claude/ ./.claude/

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data /home/node/.claude && \
    echo '{}' > /home/node/.claude.json && \
    chown -R node:node /data /home/node/.claude /home/node/.claude.json

USER node
CMD ["node", "dist/index.js"]
