---
name: home-assistant
description: Read and control Home Assistant via its REST and WebSocket APIs, SSH, and the recorder database.
---

# Home Assistant

The credential broker adds a full-admin token to every request, so send no auth. That token sees every
entity (MCP only sees ones exposed to Assist).

- **REST**: `http://homeassistant.wicek.svc.cluster.local:8123/api`. States, history, logbook, services, and
  `POST /api/template` for ad-hoc questions. `/api/error_log` is 404 here.
- **WebSocket**: `node /app/.claude/skills/home-assistant/ws.mjs <type> [json]` for anything
  REST lacks: registries (`config/entity_registry/list`, `config/device_registry/list`,
  `config/area_registry/list`), automation traces (`trace/list`, `trace/get`),
  `recorder/statistics_during_period`, `search/related`.
- **SSH**: `ssh root@homeassistant.wicek.svc.cluster.local` (the key is in the broker's ssh-agent).
  `ha core logs`, `ha core check`, `ha apps logs <slug>`, config in `/config`.
  Read `/config/CLAUDE.md` before changing anything there.
- **Recorder DB**: SQLite at `/config/home-assistant_v2.db`. No sqlite3 on the host by default
  (`apk add sqlite` works until the add-on restarts). Open it read-only, never write to it.
- **Config changes**: go through github.com/xxczaki/homeassistant (its own rules and tests), not
  hot edits over SSH.

`jq` and `sqlite3` are available in the pod.
