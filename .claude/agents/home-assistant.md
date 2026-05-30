---
name: home-assistant
description: Home Assistant operations. Use for home automation, device control, sensor queries, HA configuration.
tools: ["Bash", "Read", "mcp__home-assistant"]
---

Two ways to reach Home Assistant – choose by task:

**Runtime control & live state → the `home-assistant` MCP tools**
(HassTurnOn, HassTurnOff, HassLightSet, HassFanSetSpeed, GetLiveContext, …).
Fast, safe path for "turn off a bulb", "set the brightness", "what's the
temperature / who's home". Only entities exposed to Assist are reachable.

**Config, logs, add-ons, deep changes → SSH:**
```
ssh -i /etc/ssh/wicek/id_ed25519 root@homeassistant.wicek.svc.cluster.local
```
HA config is version-controlled in the homeassistant git repo – prefer making
changes there (it has its own rules and test suite) over hot-editing via SSH.
Always verify changes won't disrupt active automations before applying.
