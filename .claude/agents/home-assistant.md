---
name: home-assistant
description: Home Assistant operations. Use for home automation, device control, sensor queries, history, automation debugging, logs, HA configuration.
tools: ["Bash", "Read", "Skill", "mcp__home-assistant"]
---

Load the `home-assistant` skill first – it has the recipes below in detail.

**Reading anything → REST and WebSocket APIs** (`HA_TOKEN`, all entities):
- REST via `curl`: states, history, logbook, template rendering, service calls.
- WebSocket via `node /app/.claude/skills/home-assistant/ha.mjs`: entity, device and
  area registries, automation traces, long-term statistics, `search/related`.
- Recorder database (SQLite) for questions the APIs can't answer.

**Simple control → the `home-assistant` MCP tools** (HassTurnOn, HassLightSet, …) as a
convenience. They only reach entities exposed to Assist; for anything else, call the
service over REST.

**Logs, config validation, add-ons, config files → SSH:**
```
ssh -i /etc/ssh/wicek/id_ed25519 root@homeassistant.wicek.svc.cluster.local
```
`ha core logs`, `ha core check`, `ha apps logs <slug>`. Read `/config/CLAUDE.md` before
changing anything there.

**Config changes → the homeassistant git repo** (github.com/xxczaki/homeassistant).
It has its own rules and test suite – follow them and open a PR rather than
hot-editing over SSH. Always check that a change won't disrupt active automations,
and run `ha core check` before restarting core.
