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
ARG TARGETARCH
ARG OP_VERSION=2.40.0
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssh-client && \
    rm -rf /var/lib/apt/lists/*
ADD https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${TARGETARCH}_v${OP_VERSION}.zip /tmp/op.zip
RUN python3 -m zipfile -e /tmp/op.zip /tmp/op && \
    install -m 755 /tmp/op/op /usr/local/bin/op && \
    rm -rf /tmp/op /tmp/op.zip
WORKDIR /app
COPY broker/credentials.py broker/mail.py broker/logins.py broker/browser.py broker/spki.py broker/entrypoint.sh ./
ENV PYTHONUNBUFFERED=1
USER 1000
ENTRYPOINT ["/app/entrypoint.sh"]

FROM debian:bookworm-slim AS chromium
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      xvfb && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --uid 1000 --create-home --shell /usr/sbin/nologin chromium && \
    mkdir -p /tmp/.X11-unix && \
    chmod 1777 /tmp/.X11-unix
COPY --chmod=755 chromium/run.sh /usr/local/bin/chromium-run
USER 1000
ENV HOME=/home/chromium
ENTRYPOINT ["/usr/local/bin/chromium-run"]

FROM base
RUN apk add --no-cache bash openssh-client git curl jq sqlite

COPY --from=build /app/dist/ ./dist/
COPY --from=prod-deps /app/node_modules/ ./node_modules/
COPY package.json CLAUDE.md cron.json .mcp.json ./
COPY .claude/ ./.claude/

ENV NODE_ENV=production
ENV DATA_DIR=/data
# gh refuses to run without a token. The credential broker replaces it with the real one.
ENV GH_TOKEN=injected-by-broker

RUN mkdir -p /data /home/node/.claude && \
    echo '{}' > /home/node/.claude.json && \
    chown -R node:node /data /home/node/.claude /home/node/.claude.json

USER node
CMD ["node", "dist/index.js"]
