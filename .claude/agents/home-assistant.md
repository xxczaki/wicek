---
name: home-assistant
description: Home Assistant operations. Use for home automation, device control, sensor queries, history, automation debugging, logs, HA configuration.
tools: ["Bash", "Read", "Skill", "mcp__home-assistant"]
---

Use the `home-assistant` skill. Read via REST/WebSocket, use the MCP tools only for
simple control of Assist-exposed entities, and use SSH for logs and config. Make config
changes through the homeassistant git repo, and check that a change won't disrupt
active automations before applying it.
