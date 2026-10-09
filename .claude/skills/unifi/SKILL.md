---
name: unifi
description: Inspect and (with confirmation) change UniFi networks – clients, APs, radios, Wi-Fi quality history, roams, radar/DFS, neighbor scans, system log, firewall, WLANs. Use for any UniFi, Wi-Fi, router, AP, or "why is the internet/Wi-Fi bad" question.
---

# UniFi

Plain `curl` against the controller API, `jq` for JSON processing.
Never print credentials, cookies, API keys, or WLAN passphrases (`x_passphrase` in `wlanconf`).

## Access

Controllers:
- `home` – UCG-Ultra at `https://10.10.10.1`, site `default`.

The credential broker logs in, keeps the session, and logs in again after a 401, so there is no login step,
cookie jar, CSRF header, or `-k`:

```bash
curl -s https://10.10.10.1/proxy/network/api/s/default/stat/device
```

Add `-H 'content-type: application/json' -d '<json>'` for POST. The broker allows GET and POST only for this
controller: a `PUT` returns 405. For a confirmed write that needs `PUT`, tell the user it must be allowed under
the `10.10.10.1` entry's `methods` in homelab `apps/wicek/chart.yaml`. Classic endpoints return
`{meta:{rc}, data:[...]}`, v2 endpoints return plain JSON. Device objects are 30 KB+, so project fields with
`jq` before printing.

## Endpoints

All under `/proxy/network/`. Verified on the home UCG-Ultra (Network 9.x, UniFi OS 5.x).

Live state (GET):
- `api/s/{site}/stat/device[/<mac>]` – `name`, `mac`, `_id`, `model`, `state` (1 connected, 4 upgrading,
  5 provisioning), `version`, `uptime`, `radio_table` (config: `radio`, `channel`, `ht`, `tx_power_mode`,
  `tx_power`, `min_rssi_enabled`), `radio_table_stats` (live: `channel`, `tx_power`, `num_sta`, `cu_total`,
  `cu_self_rx`, `cu_self_tx`, `tx_retries_pct`, `satisfaction`, `state`), `vap_table`, `port_table`, `uplink`.
- `api/s/{site}/stat/sta` – connected clients: `mac`, `hostname`, `name`, `ip`, `ap_mac`, `essid`, `radio`
  (`ng` 2.4, `na` 5, `6e` 6 GHz), `channel`, `signal` (dBm), `satisfaction`, `tx_rate`, `rx_rate`,
  `tx_retries`, `wifi_tx_attempts`, `uptime`, `is_wired`, `sw_port`.
- `api/s/{site}/rest/user` – every known client (names, fixed IPs, notes).
- `api/s/{site}/stat/rogueap` – neighbor scan: `essid`, `bssid`, `channel`, `band`, `signal`, `ap_mac` (our AP that heard it).
- Also: `api/self/sites`, `stat/health`, `stat/sysinfo`, `stat/widget/warnings`, `stat/current-channel`,
  `stat/ccode`, `v2/api/site/{site}/clients/active`, `v2/api/site/{site}/device`.

Config (GET; writes `PUT api/s/{site}/rest/<kind>/<_id>` with only the changed fields):
- `api/s/{site}/rest/{networkconf,wlanconf,portforward,setting,portconf,routing,firewallrule,firewallgroup}`.
- `v2/api/site/{site}/{firewall-policies,firewall/zone,trafficrules,acl-rules,qos-rules,static-dns,wlan/enriched-configuration}`.
- Device: `PUT rest/device/<_id>` with e.g. the full `radio_table` array, one field edited. `GET rest/device/<_id>`
  is 404, so read and snapshot `stat/device/<mac>` instead.

Reports: `POST api/s/{site}/stat/report/<5minutes|hourly|daily>.<site|ap|user|gw>` with
`{"attrs":[...],"start":ms,"end":ms,"macs":[...]}` (`macs` optional). Rows carry `time` and `oid` (the MAC).
Retention is about 24 h for 5minutes, 7 d for hourly, 1 year for daily. Values are averages per bin.
- `ap`: `num_sta`, `bytes`, `tx_packets`, `tx_retries`, `tx_dropped`, `wifi_tx_attempts`, `satisfaction`. Per band,
  prefix `ng-`/`na-`/`6e-`: `num_sta`, `tx_retries`, `tx_packets`, `cu_total` (airtime %), `cu_self_rx`,
  `cu_self_tx`, `satisfaction`.
- `user`: `signal`, `rssi`, `satisfaction`, `tx_rate`, `rx_rate`, `tx_bytes`, `rx_bytes`, `tx_packets`,
  `rx_retries`, `tx_retries`, `wifi_tx_attempts`, `duration`. The report doesn't include the AP – get it from syslog.
- `site`: `num_sta`, `wlan-num_sta`, `wan-tx_bytes`, `wan-rx_bytes`. `gw`: `cpu`, `mem`, `latency_avg`, `wan-*_bytes`.

System log: `POST v2/api/site/{site}/system-log/<all|critical|device-alert>` (GET is 405) with
`{"timestampFrom":ms,"timestampTo":ms,"pageSize":500,"pageNumber":0}`. Page through until
`total_page_count`. Each entry has `key`, `severity`, `timestamp`, `title_raw`, and `message_raw` with `{PARAM}`
placeholders. The values are in `parameters`, each with a `.name`; `CLIENT.id` and `DEVICE.id` are MACs.
Other parameters include `CHANNEL`, `RADIO_BAND`, `SIGNAL_STRENGTH`, `WLAN`, `DURATION`, `AVG_UTILIZATION` and `AVG_INTERFERENCE`.
Keys seen: `CLIENT_CONNECTED_WIRELESS_2`, `CLIENT_DISCONNECTED_WIRELESS_2`, `NETWORK_WAN_FAILED_2`,
`NETWORK_WAN_RESTORED_2`, `ISP_PACKET_LOSS_2`. Roam, radar and channel-change keys vary by firmware, so match
`/ROAM/`, `/RADAR|DFS/`, `/CHANNEL/`. Older controllers use `EVT_WU_Roam`, `EVT_AP_RadarDetected` and
`EVT_AP_ChannelChanged` via `api/s/{site}/stat/event`, which returns 404 on home, as does `stat/alarm`.

## Recipes

Map AP MACs to names first (`stat/device`).

- **Stuck clients:** 5-minute `user` report for the client. Look for long runs at weak `signal` (below about -67)
  with no roam in the syslog while another AP would hear it better. macOS only roams reliably below about -75 on
  its side. Fixes: lower the far AP's power, or set Roaming Assistant (`min_rssi`). Never both at once.
- **Roam quality:** per client, count roams in the syslog and classify each by signal before vs. after:
  improved by 10 dB or more, sideways (±5 dB), or worse. Many sideways roams at strong signal mean two equal APs.
  Exclude watches and phones before blaming the infrastructure.
- **Airtime per AP:** hourly `ap` report with `na-cu_total`, `na-cu_self_tx`, `na-cu_self_rx`, `na-tx_retries` and
  `na-tx_packets`. Over ~50% `cu_total` on 20 MHz 5 GHz is saturated. High total with low self means
  neighbors or interference. Hourly retry ratios are skewed by idle clients. For retries under load, use
  5-minute bins with real traffic, or diff `stat/sta` counters about 150 s apart.
- **DFS/radar:** syslog over 30 days matching radar/channel keys. Note the AP, the channel before and after,
  and the off-air gap. Check who was on the AP at that moment before calling it user-impacting.
  Channels 120–132 sit inside weather-radar guard zones near airports.
- **Neighbor congestion:** `stat/rogueap` grouped by our `ap_mac` and `channel`. Count BSSIDs at -85 dBm or
  stronger, since those contend for airtime. Compare UNII-1 36–48, DFS 52–64, DFS 100–144 and UNII-3 149–165.
- **Disconnects:** group syslog disconnects by client and time. End-of-day waves are people leaving.

## Change protocol

Read-only by default. For any write (radios, WLANs, firewall, DNS, networks, restarts), do one change at a time:

1. **Propose** the object, field, old → new, client impact (DFS channels 52–144 add a 60 s check), and rollback.
   Wait for an explicit yes.
2. **Snapshot** the object to `/data/unifi/snapshots/<UTC ts>_<controller>_<object>.json` (`mkdir -p` first).
3. **Apply** one `PUT` with only the changed fields.
4. **Wait:** poll `stat/device/<mac>` every 5 s until `state` is 1 and `radio_table_stats` shows the new
   channel/power twice in a row.
5. **Verify** against the snapshot: channel, actual `tx_power` (Medium/High resolve to different dBm per channel),
   SSIDs up, and clients back.
6. **Record:** append time, controller, change, reason, snapshot path, settle time and result to
   `/data/unifi/changes.md`, and save a memory with the applied state and what to check next.
7. **Roll back** by putting back the snapshot's values for the same fields if verification fails.
