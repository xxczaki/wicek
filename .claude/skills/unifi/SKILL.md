---
name: unifi
description: Inspect and (with confirmation) change UniFi networks – clients, APs, radios, Wi-Fi quality history, roams, radar/DFS, neighbor scans, system log, firewall, WLANs. Use for any UniFi, Wi-Fi, router, AP, or "why is the internet/Wi-Fi bad" question.
---

# UniFi

`unifi.mjs` talks to UniFi controllers listed in `controllers.json`. It logs in once, caches the
session in `/data/tmp/unifi-session-<controller>.json` (0600), and re-logs in on 401/403. Output is JSON
on stdout, errors are `{"error": ...}` on stderr with exit code 1.

```
node /app/.claude/skills/unifi/unifi.mjs <command> [args] [--controller home] [--site default]
```

Never print or echo credentials, cookies, API keys, or WLAN passphrases (`x_passphrase` in `wlanconf`).

## Commands

- `controllers` – configured controllers and whether their credentials are present.
- `get <path>` / `post <path> <json>` / `put <path> <json>` – raw API call.
  - Relative paths are prefixed with `/proxy/network/`. `{site}` is replaced with the site.
  - Classic `{meta, data}` responses are unwrapped to `data`. `--raw` keeps the full body.
  - `--fields a,b.c,radio_table.0.channel` projects each array item. Use it – raw device objects are 30 KB+.
- `report <5minutes|hourly|daily|monthly> <site|ap|user|gw> [--from] [--to] [--attrs a,b] [--macs m1,m2]`
  – historical stats, defaults `--from -24h --to now`. Adds `time_iso`. Rows carry `oid` (AP or client MAC).
- `syslog [--category all|critical|device-alert] [--from] [--to] [--key REGEX] [--grep REGEX] [--limit N] [--raw]`
  – system log, paginated, rendered to one-line messages with `client` and `device` MACs.
- `snapshot <path> [--label name]` – GET and save to `/data/unifi/snapshots/<ts>_<controller>_<label>.json`.
- `wait <device-mac> [--radio na] [--channel 52] [--tx-power 6] [--timeout 600]` – poll every 5 s until the
  device is connected (`state` 1) and matches the expectations twice in a row. Progress goes to stderr,
  exits 2 on timeout.
- `logout` – drop the cached session.

Times: ISO 8601, epoch ms, `now`, or relative `-30m`, `-6h`, `-2d`. Report retention by default: 5-minute
≈ 24 h, hourly ≈ 7 d, daily ≈ 1 year. For a past workday use `hourly`, or `5minutes` if within 24 h.

## Endpoints

Verified on the home UCG-Ultra (Network 9.x, UniFi OS 5.x). Site is `default` unless configured otherwise.

Inventory and live state (GET):
- `api/self/sites` – sites on the controller.
- `api/s/{site}/stat/device` – all devices. `stat/device/<mac>` for one. Key fields: `name`, `mac`, `_id`,
  `model`, `state` (1 connected, 4 upgrading, 5 provisioning), `version`, `uptime`, `satisfaction`,
  `radio_table` (config: `radio`, `channel`, `ht`, `tx_power_mode`, `tx_power`, `min_rssi_enabled`),
  `radio_table_stats` (live: `channel`, `tx_power`, `num_sta`, `cu_total`, `cu_self_rx`, `cu_self_tx`,
  `tx_retries_pct`, `satisfaction`, `state`), `vap_table` (per-SSID per-radio), `port_table`, `uplink`.
- `api/s/{site}/stat/sta` – connected clients: `mac`, `hostname`, `name`, `ip`, `ap_mac`, `essid`,
  `radio` (`ng` 2.4, `na` 5, `6e` 6 GHz), `channel`, `signal` (dBm), `rssi`, `satisfaction`, `tx_rate`,
  `rx_rate`, `tx_retries`, `wifi_tx_attempts`, `uptime`, `is_wired`, `sw_mac`, `sw_port`.
- `v2/api/site/{site}/clients/active` – richer live client list. `v2/api/site/{site}/device` – v2 devices.
- `api/s/{site}/rest/user` – every known client (names, fixed IPs, notes).
- `api/s/{site}/stat/rogueap` – neighbor scan: `essid`, `bssid`, `channel`, `band`, `signal`, `ap_mac`
  (our AP that heard it), `is_rogue`, `last_seen`.
- `api/s/{site}/stat/current-channel`, `stat/ccode` – allowed channels for the country.
- `api/s/{site}/stat/health`, `stat/sysinfo`, `stat/widget/warnings`, `stat/sitedpi`.

Config (GET; PUT with `rest/<kind>/<_id>`):
- `api/s/{site}/rest/networkconf`, `rest/wlanconf`, `rest/portforward`, `rest/setting`, `rest/portconf`,
  `rest/routing`, `rest/firewallrule`, `rest/firewallgroup`, `rest/dhcpoption`.
- `v2/api/site/{site}/firewall-policies`, `firewall/zone`, `trafficrules`, `acl-rules`, `qos-rules`,
  `static-dns`, `wlan/enriched-configuration`, `vpn/connections`.
- Device config writes go to `PUT api/s/{site}/rest/device/<_id>` with only the changed fields, e.g.
  `{"radio_table":[...full radio_table with one field changed...]}`. `GET rest/device/<_id>` is 404 –
  snapshot `stat/device/<mac>` instead.

Reports (`report` command, `POST api/s/{site}/stat/report/<interval>.<type>`):
- `ap`: `num_sta`, `bytes`, `tx_bytes`, `rx_bytes`, `tx_packets`, `rx_packets`, `tx_retries`, `tx_dropped`,
  `wifi_tx_attempts`, `wifi_tx_dropped`, `satisfaction`, `user-num_sta`, `guest-num_sta`. Per band, prefix
  with `ng-`, `na-`, `6e-`: `num_sta`, `tx_retries`, `tx_packets`, `wifi_tx_attempts`, `cu_total` (channel
  utilization %, i.e. airtime), `cu_self_rx`, `cu_self_tx`, `satisfaction`, `tx_bytes`, `rx_bytes`.
- `user`: `signal`, `rssi`, `satisfaction`, `tx_rate`, `rx_rate`, `tx_bytes`, `rx_bytes`, `tx_packets`,
  `rx_packets`, `tx_retries`, `rx_retries`, `wifi_tx_attempts`, `duration` (ms connected in the bin).
  The AP a client was on is not in the report – take it from syslog connect/roam events or `stat/sta`.
- `site`: `num_sta`, `wlan-num_sta`, `lan-num_sta`, `bytes`, `wan-tx_bytes`, `wan-rx_bytes`.
- `gw`: `wan-tx_bytes`, `wan-rx_bytes`, `lan-tx_bytes`, `lan-rx_bytes`, `cpu`, `mem`, `latency_avg`.
- Values are per-bin averages. Retry rate = `tx_retries / tx_packets` (or `/ wifi_tx_attempts`). Hourly
  ratios are dominated by idle clients – for "is this AP retrying under load", use 5-minute bins with
  meaningful `tx_packets`, or sample `stat/sta` twice ~150 s apart and diff the counters.

System log (`syslog` command, `POST v2/api/site/{site}/system-log/<category>`; GET is 405):
- Body `{"timestampFrom":ms,"timestampTo":ms,"pageSize":N,"pageNumber":0}`. Response
  `{data, page_number, total_page_count, total_element_count}`.
- Entries: `key`, `event`, `category`, `subcategory`, `severity`, `timestamp`, `title_raw`, `message_raw`
  with `{PARAM}` placeholders, `parameters` (`CLIENT.id` MAC, `DEVICE.id` AP MAC, `CHANNEL`, `RADIO_BAND`,
  `SIGNAL_STRENGTH`, `WLAN`, `DURATION`, `DATA_UP`/`DATA_DOWN`, `AVG_UTILIZATION`, `AVG_INTERFERENCE`).
- Seen keys: `CLIENT_CONNECTED_WIRELESS_2`, `CLIENT_DISCONNECTED_WIRELESS_2`, `NETWORK_WAN_FAILED_2`,
  `NETWORK_WAN_RESTORED_2`, `NETWORK_WAN_FAILED_MULTIPLE_TIMES_2`, `ISP_PACKET_LOSS_2`. Roam, radar and
  channel-change keys differ by firmware – filter with `--key ROAM`, `--key RADAR|DFS`, `--key CHANNEL`.
  Older controllers use legacy events (`EVT_WU_Roam`, `EVT_WU_Disconnected`, `EVT_AP_RadarDetected`,
  `EVT_AP_ChannelChanged`) under `api/s/{site}/stat/event`.

Not available on the home controller: `stat/event`, `stat/alarm`, `list/alarm` (404/400), `stat/spectrumscan`.
`integration/v1/*` needs an API key (`apikey` or `cloud` auth).

## Recipes

Always start with `stat/device --fields name,mac,model,state,radio_table_stats` to map AP MACs to names.

- **Stuck clients:** `report 5minutes user --macs <mac>` across the window. Long runs at weak `signal`
  (below about -67) with `satisfaction` dropping and no roam in syslog, while another AP would hear it
  better (`stat/sta` after it moves, or neighboring APs' coverage), mean a sticky client. macOS roams
  reliably only below about -75 dBm on its side. Fixes: lower the far AP's power, or Roaming Assistant
  (`min_rssi`) – never both at once.
- **Roam quality:** `syslog --key 'ROAM|CONNECTED|DISCONNECTED' --from <day start> --to <day end> --limit 5000`.
  Per client, count roams and classify each by signal before vs after: improved by 10 dB+, sideways (±5 dB),
  worse. Many sideways roams at strong signal mean two APs are equally good where the client sits. Exclude
  watches and phones bouncing between equal APs before judging infrastructure.
- **Airtime per AP:** `report hourly ap --attrs time,num_sta,na-cu_total,na-cu_self_tx,na-cu_self_rx,na-tx_retries,na-tx_packets`
  (swap `na` for `ng`/`6e`). `cu_total` above ~50% on 5 GHz at 20 MHz is saturated. High `cu_total` with
  low `cu_self_*` is neighbor/interference airtime. Pair with `report hourly user` to find the heavy client.
- **DFS/radar history:** `syslog --key 'RADAR|DFS|CHANNEL' --from -30d`. Note AP, old/new channel, time,
  and the off-air gap. Cross-check who was on the AP (`report 5minutes ap --attrs time,na-num_sta`)
  before calling it user-impacting. Channels 120–132 fall within weather-radar guard zones near airports.
- **Neighbor congestion per channel:** `get api/s/{site}/stat/rogueap --fields ap_mac,channel,band,signal,essid`.
  Group by our `ap_mac` and `channel`, count BSSIDs at -85 dBm or stronger (those contend for airtime),
  list weaker ones separately. Compare blocks: UNII-1 36–48, DFS 52–64, DFS 100–144, UNII-3 149–165.
- **Disconnect attribution:** `syslog --key DISCONNECTED`, group by client and time. Waves at the end of the
  day are people leaving, not a fault.
- **Workday sweep:** for a day, pull `report hourly ap` (load, retries, `cu_total`), `report 5minutes user`
  for all clients if within 24 h, and the syslog. Report the worst clients, saturated APs, roam counts per
  hour, and radar events, then recommend at most one change.

## Change protocol

Read-only by default. Any `post`/`put` that changes config (radios, WLANs, firewall, DNS, networks, port
profiles, device restarts) follows these steps, one change at a time:

1. **Propose:** state the exact object, field, old → new value, expected client impact (blip length,
   DFS 60 s check for channels 52–144), and how to roll back. Wait for an explicit yes in chat.
2. **Snapshot:** `snapshot api/s/{site}/stat/device/<mac> --label <ap>-before-<change>` (or the `rest/...`
   collection for WLAN/network/firewall changes). Note the saved path.
3. **Apply one change:** `put` only the changed fields to `rest/<kind>/<_id>`. For `radio_table`, send the
   full array from the snapshot with one field edited.
4. **Wait:** `wait <mac> --radio na --channel <new>` or `--tx-power <dBm>` until it settles.
5. **Verify:** re-read `stat/device/<mac>` and `stat/sta` – channel, power, SSIDs up, clients back.
   Compare against the snapshot and say what actually changed (e.g. Medium resolved to 15 dBm).
6. **Record:** append to `/data/unifi/changes.md` – time (UTC), controller, object, old → new, reason,
   snapshot path, settle time, verification. Save a memory with the current applied state and what to
   check next (e.g. next-day roam and retry comparison).
7. **Rollback** if verification fails: `put` the snapshot's values for the same fields, then `wait` again.

## Controllers

`controllers.json` (in this skill directory, changed via a PR to the wicek repo). The first entry is the
default. Auth types:

- `local` – UniFi OS username/password, `url` of the console, `insecure: true` for self-signed certs,
  `usernameEnv`/`passwordEnv` name the env vars.
- `apikey` – local console with an API key (UniFi OS → Network → Settings → Control Plane → Integrations),
  `url` and `apiKeyEnv`.
- `cloud` – Site Manager cloud connector, no VPN needed. `consoleId` and `apiKeyEnv` (key from
  unifi.ui.com → API). Requests go to `https://api.ui.com/v1/connector/consoles/<consoleId>/proxy/network/...`
  with `X-API-KEY`, so every path above works unchanged, including writes.

```json
"nyc": {
  "description": "NYC office",
  "auth": "cloud",
  "consoleId": "<id from GET https://api.ui.com/v1/hosts>",
  "apiKeyEnv": "UNIFI_NYC_API_KEY",
  "site": "default"
}
```

To add one: put the secret into `wicek-secrets` (homelab `apps/wicek/sealed-secret.yaml`), expose it as an env
var in the Helm chart (charts `charts/wicek/templates/deployment.yaml` + homelab `apps/wicek/chart.yaml`), and
add the entry here. Find the console ID with
`curl -s -H "X-API-KEY: $UNIFI_NYC_API_KEY" https://api.ui.com/v1/hosts` and read `id` – do not print the key.

For visual tasks (topology, UI-only settings), drive the console UI with the chrome-devtools MCP.
