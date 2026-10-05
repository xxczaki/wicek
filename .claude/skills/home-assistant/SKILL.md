---
name: home-assistant
description: Read and control Home Assistant through its REST and WebSocket APIs, SSH, and the recorder database. Use for entity/device/area lookups, history and statistics, automation traces, logs, config checks, and service calls.
---

# Home Assistant

Base URL: `http://homeassistant.wicek.svc.cluster.local:8123`. Auth for REST and
WebSocket: `HA_TOKEN` (long-lived token, full admin). It sees all entities, not just
the ones exposed to Assist.

Pick the tool by task:
- Live state, history, logbook, templates, service calls → REST (`curl`).
- Registries (entities, devices, areas), automation traces, long-term statistics,
  "what uses X" → WebSocket helper `ha.mjs`.
- Logs, config validation, add-ons, reading config files → SSH.
- Raw SQL over history → recorder DB.
- Config changes → the homeassistant git repo (see below).

`jq` and `sqlite3` are installed in the pod.

## REST

Send `-H "Authorization: Bearer $HA_TOKEN"` on every request (abbreviated as `$AUTH`
below) and `-H "Content-Type: application/json"` on POSTs. `$HA` stands for
`http://homeassistant.wicek.svc.cluster.local:8123/api`.

- All states: `curl -s $AUTH $HA/states | jq '.[] | {entity_id, state}'`
- One entity: `curl -s $AUTH $HA/states/light.kitchen`
- History (start defaults to 1 day ago):
  `curl -s $AUTH "$HA/history/period/2026-10-04T00:00:00Z?filter_entity_id=sensor.a,sensor.b&end_time=2026-10-05T00:00:00Z&minimal_response&no_attributes"`
- Logbook: `curl -s $AUTH "$HA/logbook/2026-10-04T00:00:00Z?entity=light.kitchen&end_time=..."`
- Render a template (best for ad-hoc questions – `states`, `area_entities`, `device_attr`, `expand`, …):
  `curl -s $AUTH -X POST $HA/template -d '{"template":"{{ states.light | selectattr(\"state\",\"eq\",\"on\") | map(attribute=\"entity_id\") | list }}"}'`
- Call a service:
  `curl -s $AUTH -X POST $HA/services/light/turn_on -d '{"entity_id":"light.kitchen","brightness_pct":40}'`
  Append `?return_response` for services that return data (e.g. `weather.get_forecasts`).
- Services list: `curl -s $AUTH $HA/services`; config: `$HA/config`; calendars: `$HA/calendars`.
- Fire an event: `curl -s $AUTH -X POST $HA/events/<event_type> -d '{...}'`

`/api/error_log` returns 404 here – use `ha core logs` over SSH.

## WebSocket helper

```
node /app/.claude/skills/home-assistant/ha.mjs <command> [args] [--flags]
```

JSON on stdout; errors as `{"error": ...}` on stderr with exit code 1.

- `entities | devices | areas | floors | labels | config-entries | services` – registries
- `traces [item_id]` – recent automation runs (`--domain script` for scripts)
- `trace <item_id> <run_id>` – full trace: trigger, conditions, each step, errors
- `statistic-ids [--type mean|sum]` – entities with long-term statistics
- `statistics <id[,id]> --start <ISO> [--end <ISO>] [--period 5minute|hour|day|week|month]`
  – timestamps in the result are epoch ms; `{}` means no data in range
- `related <item_type> <item_id>` – e.g. `related entity light.kitchen` lists automations,
  scripts, scenes, devices and areas that reference it
- `subscribe [event_type] [--seconds 30]` – stream events as JSON lines (e.g. `state_changed`)
- `ws <type> [json]` – any other command, e.g.
  `ws get_config`, `ws config/entity_registry/get '{"entity_id":"light.kitchen"}'`,
  `ws config/entity_registry/update '{"entity_id":"light.kitchen","name":"Kitchen"}'`,
  `ws recorder/info`, `ws repairs/list_issues`, `ws system_health/info`

Automation `item_id` is the automation's `id` from YAML (`attributes.id` on the
`automation.*` state), not its entity ID.

## SSH

```
ssh -i /etc/ssh/wicek/id_ed25519 root@homeassistant.wicek.svc.cluster.local '<command>'
```

Root shell in the SSH add-on (Alpine, has `ha`, `curl`, `jq`, `apk`). `/config` is
the live config directory.

- Core logs: `ha core logs | tail -200` (filter with `grep -i error`)
- Validate config before any restart: `ha core check`
- Restart/reload: `ha core restart` (prefer reload services via REST, e.g. `automation/reload`)
- Add-ons: `ha apps list`, `ha apps info <slug>`, `ha apps logs <slug>`
- Host/supervisor: `ha host info`, `ha supervisor logs`, `ha resolution info`
- Read config: `cat /config/configuration.yaml`, `ls /config/packages`, `cat /config/automations.yaml`
- Registries on disk: `/config/.storage/core.entity_registry`, `core.device_registry`, `core.area_registry`

Never restart Mosquitto (`core_mosquitto`) while Zigbee2MQTT runs – it can corrupt the Z2M
database. Read `/config/CLAUDE.md` before changing anything on the host.

## Recorder database

SQLite at `/config/home-assistant_v2.db` (~560 MB, WAL mode). Tables: `states` +
`states_meta` (entity_id lookup), `events` + `event_types`, `statistics` (hourly),
`statistics_short_term` (5-minute), `statistics_meta`. Times are epoch seconds
(`last_updated_ts`, `start_ts`).

Query in place (sqlite is not preinstalled; `apk add` lasts until the add-on restarts):

```
ssh ... 'apk add -q --no-cache sqlite && sqlite3 -readonly -json /config/home-assistant_v2.db "
  SELECT s.state, datetime(s.last_updated_ts, \"unixepoch\") AS at
  FROM states s JOIN states_meta m USING (metadata_id)
  WHERE m.entity_id = \"sensor.bathroom_temperature\"
  ORDER BY s.last_updated_ts DESC LIMIT 20"'
```

For heavy analysis, take a consistent snapshot and query it locally:

```
ssh ... 'apk add -q --no-cache sqlite && sqlite3 /config/home-assistant_v2.db ".backup /tmp/ha.db"'
ssh ... 'cat /tmp/ha.db && rm /tmp/ha.db' > /data/ha.db
sqlite3 -readonly /data/ha.db '...'
```

Delete `/data/ha.db` when done. Never write to the live database.

## Config changes

HA config lives in github.com/xxczaki/homeassistant (public repo). Clone it to `/data`,
follow its `CLAUDE.md` (secret handling, Z2M rules) and run its tests, then open a PR.
A git pull add-on syncs merged changes to HA. Hot-edit over SSH only for urgent fixes,
and then port the change to the repo. Run `ha core check` before restarting core.

Registry-only changes (entity names, areas, labels, disabling entities) are not in YAML –
make them through the WebSocket API (`ws config/entity_registry/update ...`).
