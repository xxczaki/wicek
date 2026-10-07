<p align="center">
  <img src=".github/logo.svg" width="80" alt="Wicek" draggable="false">
</p>

# Wicek

[![CI](https://github.com/xxczaki/wicek/actions/workflows/ci.yml/badge.svg)](https://github.com/xxczaki/wicek/actions/workflows/ci.yml)

> Task-focused AI assistant running as a Discord bot, powered by Claude Code

A minimal Node.js application that drives the [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk) and exposes it through Discord. Built to replace a bloated third-party Kubernetes operator ([openclaw-rocks](https://github.com/openclaw-rocks)) with something lean and maintainable.

> [!WARNING]
> This project is experimental and should not be used directly as-is.

## Motivation

[OpenClaw](https://openclaw.ai/) is a capable AI agent platform with a broad feature set – multiple messaging channels, vector memory, browser automation, self-configuration, and more. For a single-user setup on a Raspberry Pi where only Discord and a handful of tools are needed, most of that goes unused. Wicek replaces it with ~500 lines of TypeScript, a single Deployment, and a Helm chart.

## What it does

- **Discord integration** – DMs, @mentions, and threaded conversations via [discord.js](https://discord.js.org/)
- **Claude Agent SDK** – runs `query()` per request on a Pro/Max subscription (OAuth token, no API key), streaming results back to Discord with thinking (blockquotes), tool use, and text
- **Browser automation** – headless Chrome sidecar with [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), screenshots auto-attached to Discord
- **Cron jobs** – GitOps-defined scheduled prompts (e.g., daily ETF updates)
- **Webhooks** – GitHub CI failures and Grafana alerts start debounced agent runs (`POST /hooks/github`, `POST /hooks/grafana`, `GET /healthz` on `WEBHOOK_PORT`, default 8080), exposed via Tailscale Funnel
- **Custom subagents** – `.claude/agents/` for ETF analysis, infrastructure ops, Home Assistant
- **File handling** – receives Discord attachments, sends back generated files and screenshots
- **Self-update** – knows how to push changes through the GitOps pipeline (git -> ArgoCD)
- **Long-term memory** – Claude Code's native auto-memory on persistent storage

## Deployment

Runs on a single-node K3s cluster (Raspberry Pi 4). See [xxczaki/homelab](https://github.com/xxczaki/homelab) for the full cluster setup and [xxczaki/charts](https://github.com/xxczaki/charts) for the Helm chart.

### Credential broker

Service credentials live in a sidecar (`ghcr.io/xxczaki/wicek-broker`, source in `broker/`), not in the agent container. It is [mitmproxy](https://mitmproxy.org/) with a small add-on, listening on `127.0.0.1:3128`. The agent container sends its traffic through it via `HTTP(S)_PROXY` and trusts the broker's CA, so tools call the real URLs without credentials and the broker adds the real ones. The image sets a placeholder `GH_TOKEN` because `gh` refuses to run without one. Git needs no credential helper.

Only hosts listed in the config are intercepted. Everything else is tunneled through untouched, and the hosts in `NO_PROXY` (Claude API, Discord) bypass it. For a listed host, the broker drops client `Authorization`/`Cookie`/CSRF headers, adds its own, removes `Set-Cookie` and CSRF headers from the response, and logs one line per request without bodies or query strings. Auth types:

- `bearer` – `Authorization: Bearer <tokenFile>`
- `basic` – `Authorization: Basic` from `username` or `usernameFile`, plus `passwordFile`
- `home-assistant` – `bearer`, plus the `access_token` in the WebSocket `auth` message
- `enable-banking` – `Authorization: Bearer` with a short-lived RS256 JWT signed with `privateKeyFile`, its `kid` read from `applicationIdFile`
- `unifi` – logs in with `usernameFile`/`passwordFile`, keeps the `TOKEN` cookie and CSRF token, logs in again after a 401
- `imap` – the broker answers the request itself as a read-only mail gateway for `server` (port 993), logging in with `usernameFile`/`passwordFile`. Endpoints: `GET /folders`, `/search` (`folder`, `from`, `to`, `subject`, `text`, `since`, `before`, `unseen`, `limit`) `/message` (`folder`, `uid`) and `/attachment` (`folder`, `uid`, `index`, raw bytes up to 25 MB). It opens folders with `EXAMINE` and fetches with `BODY.PEEK`, so it can't change the mailbox or mark messages as read. Use a made-up host such as `http://imap.broker`

Optional per host: `methods` (allowlist) and `insecureTls` (self-signed upstreams). Top-level `"blockUnlisted": true` rejects every host not in the list instead of tunneling it. Hosts may use a leading `*.` wildcard. The config is read from `BROKER_CONFIG` (default `/etc/broker/config.json`):

```json
{
  "hosts": [
    {
      "host": "parsify.grafana.net",
      "auth": { "type": "bearer", "tokenFile": "/run/broker/grafana-cloud/credential" }
    }
  ]
}
```

Mail is quarantined from the main agent. The gateway's tools (`src/claude/mail.ts`) belong to a `mail-reader` subagent that can't use anything else, and hooks stop every other agent and tool from reaching them or the gateway. Email can carry prompt injection, so its text only reaches an agent that can't act on it, and the main agent gets summaries.

The CA is generated once per pod in a sidecar-only volume. Only the certificate (`/run/broker-ca/ca.pem`) and a system bundle that includes it (`bundle.pem`) are shared with the agent. The sidecar also runs `ssh-agent` on `SSH_AUTH_SOCK` with the keys in `SSH_KEY_FILES` (space-separated), so the agent can use SSH keys without reading them.

### Readers

A reader answers questions about one untrusted data source (e.g. bank transactions) from a separate pod: `node dist/reader.js` running an Agent SDK query with only Bash, in a Kata VM. Its credential broker runs as its own pod outside the VM with `"blockUnlisted": true`, so the reader can reach only that broker, and the broker only the hosts in its config – everything else gets a 403. The main agent calls a reader with the `ask_reader` tool (`src/claude/readers.ts`, configured by the `READERS` env var), and the bot posts the answer straight to Discord, so the main agent never sees text a third party could have written. The answer is an embed labeled as private, and a `PostToolUse` hook ends the main agent's turn right after it, so it can't add its own take.

Readers whose API needs a browser login get a redirect URL, `READER_CALLBACK_URL` (`<webhooks host>/hooks/callback/<reader>`). The reader saves a random `state` to `<state dir>/pending-callback` before handing out the login link. When the browser comes back, the webhook server shows a static page and forwards the query to the reader's `POST /callback`, which compares `state` in code (constant time, single use) before the model sees anything. The answer goes to the conversation that last asked that reader (in memory, else the owner's DMs). Without a matching state the public route does nothing.

The reader fetches the broker's CA from `http://mitm.it/cert/pem` through the broker before each question, since the broker generates a new one when it restarts. Its system prompt is the shared rules in `src/reader.ts`, the reader's own prompt mounted at `READER_PROMPT_PATH`, and `<state dir>/notes.md` – facts the user stated, never API data. It keeps state in `READER_STATE_DIR`.

Each `POST /ask` carries the main side's conversation key (`dm:`, `thread:`, or `channel:`), and the reader resumes one Agent SDK session per key (`src/reader/sessions.ts`), so follow-ups build on earlier answers. Transcripts contain API data, so they live under `HOME` (an emptyDir), not in the backed-up state directory. They're lost on restart and deleted after 12 idle hours or beyond 20 sessions.

## AI disclosure

This project contains code generated by Large Language Models (LLMs), under human supervision and proofreading.

## License

MIT
