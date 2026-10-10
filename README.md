<p align="center">
  <img src=".github/logo.svg" width="80" alt="Wicek" draggable="false">
</p>

# Wicek

[![CI](https://github.com/xxczaki/wicek/actions/workflows/ci.yml/badge.svg)](https://github.com/xxczaki/wicek/actions/workflows/ci.yml)

> A personal assistant on Discord, powered by the Claude Agent SDK and running on a Raspberry Pi

Wicek is a single-user assistant you talk to in Discord. It works across your homelab, your home, your inbox, your bank, and websites you're logged in to. It's small on purpose: a TypeScript app, a Python credential broker, one Deployment, and a Helm chart.

> [!WARNING]
> This project is experimental and should not be used directly as-is.

## History

Wicek started from [OpenClaw](https://openclaw.ai/) (run via [openclaw-rocks](https://github.com/openclaw-rocks)), the initial inspiration. OpenClaw is a broad agent platform, and in a single-user setup on a Raspberry Pi most of it went unused. Wicek kept the parts that were used (Discord, a browser, scheduled prompts, memory), built them on Claude Code instead of a platform of its own, and replaced it.

In September and October 2026, hosted personal agents arrived: Meta's [Muse](https://www.pbs.org/newshour/nation/meta-launches-personal-ai-agent-muse-to-help-with-everyday-tasks), OpenAI's [Dots](https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/), and [Grok Bot](https://9to5mac.com/2026/10/09/grok-bot-just-got-its-own-email-address-heres-how-to-claim-yours/) with its own email inbox. They run on their vendor's machines with their own browser, computer, or inbox, and act inside the user's accounts. That set the direction for Wicek's roadmap: Grok Bot getting its own inbox to sign in to services led directly to website logins, where Wicek uses logins from a 1Password vault, emailed codes included, without the model ever seeing a password.

Wicek follows the same direction on your own hardware. Its credentials, memory, and integrations stay there, and you can read every line that touches them, while the model runs on Anthropic's API. It reaches far fewer services than the hosted agents, and you maintain it yourself.

## Philosophy

- **Small enough to read in an afternoon.** Claude Code already ships memory, skills, subagents, and tools. Wicek connects them to Discord and the homelab instead of rebuilding them.
- **The agent never holds a secret.** Credentials live in a broker sidecar that adds them to requests on the way out. API tokens, SSH keys, and website passwords never enter the agent's container or its context.
- **Untrusted text only reaches agents that can't act on it.** Email, bank data, and logged-in websites are handled by narrow subagents or isolated readers with only the tools that one job needs. What they send back is treated as data, never as instructions.
- **Read-only unless you ask.** Mail, bank, and website access are read-only by design, and network changes need a confirmation in chat.
- **Everything lives in git.** Prompts, agents, skills, cron jobs, and the deployment are in repos that ArgoCD applies. Wicek changes itself the same way you would: by opening a pull request.
- **Quiet unless it matters.** Alerts are triaged once when they start firing, and known noise, like the ISP's nightly outages, collapses to one line.

## What it's good at

- **Conversations** – DMs, @mentions, and threads via [discord.js](https://discord.js.org/). Thinking, tool use, and answers stream into Discord, and follow-up messages steer a task that's still running. Attachments go in, generated files and screenshots come back.
- **Running the homelab** – the K3s cluster, ArgoCD, SSH to the Raspberry Pi, and Grafana Cloud metrics and logs. Grafana alerts and GitHub CI failures arrive as webhooks and start a triage run, and a weekly sweep fixes broken CI and dependency PRs across the user's repos.
- **Home and network** – Home Assistant (devices, sensors, automations, logs) and UniFi (clients, Wi-Fi quality, WAN drops), with changes only after confirmation.
- **Mail, calendar, and money** – read-only iCloud mail through a quarantined subagent, the iCloud calendar, and bank balances and transactions through an isolated reader.
- **Websites you're logged in to** – move a Login item into a dedicated 1Password vault and Wicek can use it right away, emailed login codes included, without ever seeing the password. For example, it reads the contracts in a Check24 account.
- **Scheduled work** – GitOps-defined cron prompts, such as the weekly ETF recap and the weekly maintenance runs.
- **Memory and self-update** – Claude Code's auto-memory on persistent storage, and changes to its own repos through pull requests that ArgoCD deploys after merge.

## Under the hood

- **Agent** – one Agent SDK `query()` per request on a Pro/Max subscription (OAuth token, no API key)
- **Browser** – a Chromium sidecar on a virtual display, driven through [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- **Webhooks** – `POST /hooks/github`, `POST /hooks/grafana`, and `GET /healthz` on `WEBHOOK_PORT` (default 8080), exposed via Tailscale Funnel. Alerts are debounced before a run starts
- **Subagents and skills** – `.claude/agents/` (ETF analysis, infrastructure, Home Assistant, repo maintenance) and `.claude/skills/` (Apple Calendar, ETF, Home Assistant, UniFi)
- **Cron jobs** – scheduled prompts in `cron.json`

## Deployment

Runs on a single-node K3s cluster (Raspberry Pi 5). See [xxczaki/homelab](https://github.com/xxczaki/homelab) for the full cluster setup and [xxczaki/charts](https://github.com/xxczaki/charts) for the Helm chart.

### Credential broker

Service credentials live in a sidecar (`ghcr.io/xxczaki/wicek-broker`, source in `broker/`), not in the agent container. It is [mitmproxy](https://mitmproxy.org/) with a small add-on, listening on `127.0.0.1:3128`. The agent container sends its traffic through it via `HTTP(S)_PROXY` and trusts the broker's CA, so tools call the real URLs without credentials and the broker adds the real ones. The image sets a placeholder `GH_TOKEN` because `gh` refuses to run without one. Git needs no credential helper.

Only hosts listed in the config are intercepted. Everything else is tunneled through untouched, and the hosts in `NO_PROXY` (Claude API, Discord) bypass it. For a listed host, the broker drops client `Authorization`/`Cookie`/CSRF headers, adds its own, removes `Set-Cookie` and CSRF headers from the response, and logs one line per request without bodies or query strings. Auth types:

- `bearer` – `Authorization: Bearer <tokenFile>`
- `basic` – `Authorization: Basic` from `username` or `usernameFile`, plus `passwordFile`
- `home-assistant` – `bearer`, plus the `access_token` in the WebSocket `auth` message
- `enable-banking` – `Authorization: Bearer` with a short-lived RS256 JWT signed with `privateKeyFile`, its `kid` read from `applicationIdFile`
- `unifi` – logs in with `usernameFile`/`passwordFile`, keeps the `TOKEN` cookie and CSRF token, logs in again after a 401
- `imap` – the broker answers the request itself as a read-only mail gateway for `server` (port 993), logging in with `usernameFile`/`passwordFile`. Endpoints: `GET /folders`, `/search` (`folder`, `from`, `to`, `subject`, `text`, `since`, `before`, `unseen`, `limit`) `/message` (`folder`, `uid`) and `/attachment` (`folder`, `uid`, `index`, raw bytes up to 25 MB). It opens folders with `EXAMINE` and fetches with `BODY.PEEK`, so it can't change the mailbox or mark messages as read. Use a made-up host such as `http://imap.broker`
- `logins` – the broker answers the request itself with the logins in a 1Password vault, read with the `op` CLI and the service account token in `tokenFile`. Endpoints: `GET /list` (item ids, titles, domains, and placeholders, never values) and `/code?item=<id>` (digit sequences from the newest email sent by the item's domain in the last 10 minutes, read over IMAP from `mailServer` with `mailUsernameFile`/`mailPasswordFile`). Use a made-up host such as `http://logins.broker`

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

Website logins: the user moves a Login item into the vault, and it's usable right away. The `account-browser` subagent (`src/claude/logins.ts`) lists the logins, types placeholders such as `WICEK_LOGIN_<item id>_PASSWORD` in the browser, and gets emailed login codes from `/code`. The browser sidecar is Chromium on a virtual display, so a login page that waits for a normal browser still renders. Its traffic goes through a second mitmdump process on `BROKER_BROWSER_PORT` (3129) that runs only `browser.py`: it intercepts every host, and when a request body contains a placeholder, it fetches that item and swaps in the value, but only if the request goes to one of the item's URLs or their subdomains. It never adds API credentials, so pages can't use the broker's other credentials. Chrome trusts the broker's CA through `--ignore-certificate-errors-spki-list`, with the hash the broker writes to `/run/broker-ca/spki`. The subagent has only browser and login tools and can't navigate off the listed domains, and hooks keep other agents from the login tools, the gateway, and typing placeholders into the browser.

### Readers

A reader answers questions about one untrusted data source (e.g. bank transactions) from a separate pod: `node dist/reader.js` running an Agent SDK query with only Bash, in a Kata VM. Its credential broker runs as its own pod outside the VM with `"blockUnlisted": true`, so the reader can reach only that broker, and the broker only the hosts in its config – everything else gets a 403. The main agent calls a reader with the `ask_reader` tool (`src/claude/readers.ts`, configured by the `READERS` env var), and the bot posts the answer straight to Discord, so the main agent never sees text a third party could have written. The answer is an embed labeled as private, and a `PostToolUse` hook ends the main agent's turn right after it, so it can't add its own take.

Readers whose API needs a browser login get a redirect URL, `READER_CALLBACK_URL` (`<webhooks host>/hooks/callback/<reader>`). The reader saves a random `state` to `<state dir>/pending-callback` before handing out the login link. When the browser comes back, the webhook server shows a static page and forwards the query to the reader's `POST /callback`, which compares `state` in code (constant time, single use) before the model sees anything. The answer goes to the conversation that last asked that reader (in memory, else the owner's DMs). Without a matching state the public route does nothing.

The reader fetches the broker's CA from `http://mitm.it/cert/pem` through the broker before each question, since the broker generates a new one when it restarts. Its system prompt is the shared rules in `src/reader.ts`, the reader's own prompt mounted at `READER_PROMPT_PATH`, and `<state dir>/notes.md` – facts the user stated, never API data. It keeps state in `READER_STATE_DIR`.

Each `POST /ask` carries the main side's conversation key (`dm:`, `thread:`, or `channel:`), and the reader resumes one Agent SDK session per key (`src/reader/sessions.ts`), so follow-ups build on earlier answers. Transcripts contain API data, so they live under `HOME` (an emptyDir), not in the backed-up state directory. They're lost on restart and deleted after 12 idle hours or beyond 20 sessions.

## AI disclosure

This project contains code generated by Large Language Models (LLMs), under human supervision and proofreading.

## License

MIT
