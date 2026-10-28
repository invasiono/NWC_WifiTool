# Netscope — Real-Time Network & WiFi Analyzer

Netscope is a small NetSpot / WiFi Analyzer–style dashboard. A **Python Flask backend** collects live network data from the local machine (Windows `netsh`, `psutil`, `ping`), and a **single-page HTML frontend** displays it in real time.

## Project structure

```
WifiTool/
├── app.py       # Flask backend (REST API + WebSockets + speed test engine)
├── index.html   # Frontend dashboard (Tailwind + Chart.js, vanilla JS)
├── heatmap.js   # Heatmap Planner tab (canvas floor-plan + Wi-Fi coverage simulator)
├── README.md
└── .vscode/     # Editor settings
```

## Features

| Feature | Description |
|---|---|
| **Real-time bandwidth** | Upload/download Mbps from `psutil.net_io_counters()` deltas, streamed every 1 s, plotted on a live chart (30 s / 60 s / 2 min windows, pause/resume). |
| **Ping / latency** | Ping to `1.1.1.1` (Windows `ping`, TCP-53 fallback). |
| **Current WiFi info** | SSID, BSSID, band, channel, signal % / dBm, radio type, auth, cipher, RX/TX rate, via `netsh wlan show interfaces`. |
| **WiFi channel analyzer** | Nearby networks from `netsh wlan show networks mode=bssid`, drawn as spectrum curves for 2.4 GHz and 5 GHz (toggle) plus a network list. |
| **Active connections** | Table from `psutil.net_connections()` with process name, protocol, local/remote address, status; searchable, filterable, sortable. |
| **Network info / routing** | Local IP, gateway, netmask, MAC, active NIC, public IP (background fetch from ipify / Cloudflare trace every 15 s). |
| **Heatmap Planner** (tab) | Draw walls, glass and doors (drywall, brick, concrete, glass, glass/wood/metal doors, each with its own dB loss), place access points and laptops/PCs. Shows a signal heatmap, each AP's ideal vs real radius (after wall losses), and per-device RSSI, SNR, walls crossed, link rate and throughput. Plan is saved in the browser. See below. |
| **Speed test** | Runs **in the browser** against Cloudflare's speed endpoints (like fast.com / Cloudflare's open-source speedtest): latency, jitter, multi-stream download and upload, with live gauge, progress bar and grade (A+ … C). No backend WebSocket needed. |

## Heatmap Planner

Open the **Heatmap Planner** tab. Tools (shortcut): Select/Move `V`, Draw wall/door `W`, Access point `A`, Laptop `L`, PC `P`, Eraser `E`; `Delete` removes the selected item. Pick a material in the palette, drag on the plan to draw (Shift = free angle). Draw a door over a wall and it cuts an opening in that wall.

Model: `RSSI = TxPower - PL0(band) - 10 * n * log10(distance) - sum(wall losses on the straight line)` with `PL0 = 40 dB (2.4 GHz) / 47 dB (5 GHz)` and adjustable exponent `n`. The dashed circle is the ideal radius in open space; the solid outline is the real radius after walls. Devices connect to the strongest AP and show RSSI, SNR, walls crossed, link rate and estimated throughput. Values are estimates, not a site survey; compare with the "Your real Wi-Fi" card and tune `n`.

## How it works

```
Browser (index.html)  <-- HTTP / WebSocket -->  Flask (app.py)  -->  psutil / netsh / ping / route / Cloudflare
```

### Backend ([app.py](app.py))

- `PublicIPManager` – background thread that refreshes the public IP.
- `SpeedTestEngine.run(callback)` – 3 phases, reporting progress via callback:
  1. **Ping & jitter**: 5 requests to `__down?bytes=0`.
  2. **Download**: streams a 25 MB file in 128 KB chunks (max ~6.5 s), computing Mbps.
  3. **Upload**: up to 4 POSTs of 1.5 MB random data to `__up` (max ~6 s).
  Falls back to default values if a phase gets no data.
- `WifiAnalyzer` – parses `netsh` output (`get_current_wifi`, `scan_networks`).
- `SystemNetworkMonitor` – bandwidth delta, ping, local routing (`route print`), active connections.

### REST endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Serves `index.html` |
| `GET /api/wifi/current` | Current WiFi connection |
| `GET /api/wifi/scan` | Current + nearby networks |
| `GET /api/connections?limit=120` | Active connections |
| `GET /api/interfaces` | Network interfaces + routing |
| `GET /api/metrics` | Bandwidth, ping, routing, WiFi snapshot (used as polling fallback) |
| `GET /api/speedtest/run` | Synchronous speed test (no live progress) |

### WebSockets

| Route | Purpose |
|---|---|
| `/ws/telemetry` | Pushes a JSON frame every ~1 s: bandwidth, ping, routing, WiFi, connection counts. |
| `/ws/speedtest` | Client sends `{"action":"start"}`; server streams progress frames (`ping`, `download`, `download_done`, `upload`, `complete`, or `error`). |

### Frontend ([index.html](index.html))

Plain JavaScript modules inside one file:
- `Utils`, `AppState` – helpers and shared state.
- `BandwidthChart`, `ChannelChart` – Chart.js charts.
- `UIManager` – renders cards, WiFi list, connection table, status indicators.
- `SpeedTestManager` – speed test modal driven by `/ws/speedtest`.
- `App` – connects to `/ws/telemetry`; if it drops, falls back to polling `/api/metrics` every 1.5 s and auto-reconnects every 3 s. Re-scans WiFi and reloads connections every 5 s.

Loaded from CDN: Tailwind CSS, Chart.js, Google Fonts (internet required for the UI libraries).

## Requirements

- Windows (relies on `netsh`, `ping -n`, `route print`)
- Python 3.9+
- Packages: `flask`, `flask-sock`, `psutil`, `requests`

```powershell
pip install flask flask-sock psutil requests
```

## Run

```powershell
cd "c:\Users\ADMIN\OneDrive\Documents\Documents\HOCTAP\DH3\NWC303\WifiTool"
python app.py
```

Open <http://127.0.0.1:5000>. Stop with `Ctrl + C`. Change the port with the `PORT` environment variable (e.g. `$env:PORT=8080`).

> Tip: run the terminal as Administrator for fuller process names in the connections table. Restart the server after editing `app.py`.

## Troubleshooting

- **Speed test fails / "Connection failed"**: make sure the running server includes the `/ws/speedtest` route (restart `python app.py`) and that `speed.cloudflare.com` is reachable.
- **WiFi shows "Not Connected" / empty scan**: needs a WiFi adapter and Windows WLAN service; Ethernet-only PCs have no WiFi data.
- **Status shows disconnected**: the WebSocket dropped; the UI falls back to polling and reconnects automatically.
- **Public IP stuck on "Fetching..."**: no internet access to ipify / 1.1.1.1.

## Limitations

- Windows-only data collection (netsh/route/ping flags).
- Server binds to `127.0.0.1` only (local use, no authentication).
- Speed test is a lightweight estimate, not a calibrated benchmark.
