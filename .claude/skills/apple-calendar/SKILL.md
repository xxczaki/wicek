---
name: apple-calendar
description: Read and write the user's Apple (iCloud) Calendar over CalDAV. Use for checking the schedule / free-busy, and creating, updating, or deleting events.
---

# Apple Calendar (iCloud, CalDAV)

A Node script talks to iCloud CalDAV using `APPLE_ID` + `APPLE_APP_PASSWORD` from
the environment (sealed into `wicek-secrets`). All output is JSON on stdout.

Invoke:

```
node /app/.claude/skills/apple-calendar/cal.mjs <command> [--flags]
```

Commands:
- `list-calendars` — list calendars (`name`, `url`, `components`).
- `list-events --from <ISO> --to <ISO> [--calendar <name>]` — events in a time
  range; recurring events are expanded to individual occurrences. Defaults to all
  event-capable calendars.
- `create-event --summary <s> --start <ISO> --end <ISO> [--calendar <name>] [--location <l>] [--description <d>]`
  — create an event. Date-only `--start`/`--end` (e.g. `2026-06-01`) makes an all-day event.
- `update-event --url <obj-url> --etag <etag> [--summary ...] [--start ...] [--end ...] [--location ...] [--description ...]`
  — modify an event; `url` and `etag` come from `list-events`.
- `delete-event --url <obj-url> [--etag <etag>]` — delete an event.

Notes:
- Times are ISO 8601, e.g. `2026-06-01T09:00:00Z`. Prefer explicit UTC/offsets.
- For "what's on my calendar today", compute today's start/end and call `list-events`.
- This is the user's real calendar – for ambiguous create/update/delete, confirm intent first.
