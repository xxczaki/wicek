<p align="center">
  <img src=".github/logo.svg" width="80" alt="Wicek" draggable="false">
</p>

# Wicek

[![CI](https://github.com/xxczaki/wicek/actions/workflows/ci.yml/badge.svg)](https://github.com/xxczaki/wicek/actions/workflows/ci.yml)

> Opinionated, task-focused personal agent

Wicek does work across your homelab, home, inbox, bank, and logged-in websites. It has no persona and no small talk: you ask, it works, and it reports back briefly. Under the hood it's small on purpose: a TypeScript app, a Python credential broker, one Deployment, and a Helm chart.

> [!WARNING]
> This project is experimental and should not be used directly as-is.

## History

Wicek started as a replacement for OpenClaw, its initial inspiration, which was too bloated, too pricey, and too risky for one person on a Raspberry Pi. Rather than trimming OpenClaw down, it was rebuilt around Claude Code, which already provides the agent loop, memory, skills, and subagents. Wicek adds the Discord interface, configuration that lives entirely in git instead of being changed by the agent, and a security model built on isolation.

When hosted personal agents like Meta's Muse, OpenAI's Dots, and Grok Bot arrived in late 2026, they raised the bar for what a personal agent is expected to do, from browsing on its own to acting inside your accounts, and much of Wicek's later roadmap, website logins included, grew out of them. Wicek takes the same direction on your own hardware, with fewer integrations and stricter boundaries.

## Philosophy

- **Minimal surface.** As little code and instruction as possible. Point the agent in the right direction and trust it to work out the rest, instead of wrapping every API in an abstraction. Fewer wrappers also mean fewer places for vulnerabilities.
- **Creative constraints over more code.** When something gets risky or complex, constrain it (isolate it, narrow its tools, cut its network) rather than adding layers on top.
- **Architecture over instructions.** Prompts and filters are a first layer, and adaptive attacks get past them ([The Attacker Moves Second](https://arxiv.org/abs/2510.09023)). The guarantees come from what an agent can't do: hold credentials, reach the network, or call tools it wasn't given.
- **No agent gets all three.** Following Meta's [Agents Rule of Two](https://simonw.substack.com/p/new-prompt-injection-papers-agents), an agent that reads untrusted data next to sensitive data gets no way to act or reach out. Readers run in their own Kata VM, with network access limited down to DNS names, and their answers go straight to you, not to the main agent. It's a static take on the [dual LLM pattern](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) and [CaMeL](https://arxiv.org/abs/2503.18813): written once per integration instead of planned per request.
- **The agent never holds a secret.** A broker sidecar adds credentials on the way out. Tokens, SSH keys, and website passwords never enter the agent's container or context.
- **Security is worth paying for.** It serves one person, not thousands, so extra pods and VMs for isolation are a fine trade. The boundaries are maintained infrastructure (Kata, Cilium, Kubernetes policies) that rarely changes, which is where review effort is best spent.
- **Local means control.** It runs on your hardware so it can be trusted with your own systems: SSH, Home Assistant, the network.
- **GitOps, not self-configuration.** Prompts, agents, skills, cron jobs, and the deployment live in git. Wicek proposes changes to itself as pull requests instead of editing its own config.

## Capabilities

- **Chat** – DMs, mentions, and threads, with live progress, steering mid-task, and files in both directions
- **Homelab** – K3s, ArgoCD, Grafana Cloud, and SSH, plus triage of Grafana alerts and GitHub CI failures
- **Home and network** – Home Assistant and UniFi
- **Mail, calendar, and bank** – read-only iCloud mail, the iCloud calendar, and bank transactions
- **Website logins** – logins from a 1Password vault, emailed codes included, without the model seeing a password
- **Schedules** – cron prompts in git, such as the weekly ETF recap and maintenance sweeps
- **Memory** – Claude Code's auto-memory on persistent storage

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
