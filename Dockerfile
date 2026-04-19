FROM node:24.15.0-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY src/ src/
COPY tsconfig.json esbuild.js ./
RUN node esbuild.js

FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:24.15.0-alpine
RUN apk add --no-cache openssh-client git
WORKDIR /app

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
