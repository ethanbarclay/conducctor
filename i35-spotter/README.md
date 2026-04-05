# 🚗 I-35 Spotter

> Real-time exotic & performance car detection on I-35 southbound — Austin, TX.
> Identifies, scores, and logs every notable vehicle using a 4-tier AI vision pipeline.

![I-35 Spotter Dashboard](https://placehold.co/800x400/18181b/f97316?text=I-35+Spotter+Live+Dashboard)

---

## Overview

A Pi HQ Camera (IMX477 + 50mm C-mount lens) streams 1080p video from a condo balcony overlooking I-35. A self-hosted GPU pipeline classifies every vehicle in real time:

| Tier | Model | Role | Latency |
|------|-------|------|---------|
| T1 | YOLOv8s | Vehicle detection + bounding boxes | ~5ms |
| T2 | CLIP ViT-L/14 | Zero-shot make/model ID | ~50ms |
| T3 | Claude Haiku | Low-confidence / potentially exotic | ~800ms |
| T4 | Claude Sonnet | Truly unknown / rare escalation | ~2s |

Notable vehicles (score ≥ 6/10) get crop images saved and pushed live to the dashboard via WebSocket.

---

## Stack

```
Pi HQ Camera (IMX477 + 50mm)
    └── libcamera-vid → ffmpeg → mediamtx RTSP
                                     │
                              ┌──────▼──────────────┐
                              │  Detector (GPU)      │
                              │  YOLOv8 → ByteTrack  │
                              │  CLIP ViT-L/14       │
                              │  Claude Haiku        │
                              │  Claude Sonnet       │
                              └──────┬──────────────┘
                                     │
                              ┌──────▼──────────────┐
                              │  PostgreSQL          │
                              │  sightings + specs   │
                              └──────┬──────────────┘
                                     │
                              ┌──────▼──────────────┐
                              │  FastAPI             │
                              │  REST + WebSocket    │
                              └──────┬──────────────┘
                                     │
                              ┌──────▼──────────────┐
                              │  React + Tailwind    │
                              │  Live Feed           │
                              │  Leaderboard         │
                              │  Stats               │
                              │  Admin Panel         │
                              └─────────────────────┘
```

---

## Hardware

| Component | Part | Cost |
|-----------|------|------|
| Camera | Raspberry Pi HQ Camera (IMX477) | Already owned |
| Lens | Arducam 50mm C-mount | ~$47 |
| Compute | RTX 4070 Super (self-hosted) | Already owned |
| Pi | Raspberry Pi 4/5 (stream server) | Already owned |

---

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/YOUR_FORK/nanoclaw.git
cd nanoclaw/projects/i35-spotter

cp .env.example .env
# Edit .env — set DB_PASSWORD and ANTHROPIC_API_KEY
```

### 2. Test mode (no camera needed)

Put a `.mov` / `.mp4` test video in a folder, then:

```bash
# In .env:
TEST_VIDEO_DIR=/path/to/your/videos
LOOP_VIDEO=true

docker compose up --build
```

Open `http://localhost:3000` → **⚙️ Admin** tab → type `/data/test/yourfile.mov` → **▶ Start**

### 3. Production (with Pi camera)

```bash
# In .env:
VIDEO_SOURCE=rtsp://PI_IP:8554/cam

docker compose up --build
```

### 4. Seed car specs database (one-time)

```bash
docker compose exec db python /seed_specs.py
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PASSWORD` | — | PostgreSQL password |
| `ANTHROPIC_API_KEY` | — | Claude API key (Tier 3/4) |
| `VIDEO_SOURCE` | _(blank)_ | RTSP URL or `/data/test/file.mov`. Leave blank to start from Admin Panel |
| `TEST_VIDEO_DIR` | — | Host folder mounted at `/data/test` in detector container |
| `LOOP_VIDEO` | `false` | Loop test video file |
| `MIN_SCORE_TO_SAVE_CROP` | `6` | Minimum coolness score to save a crop image |
| `VITE_API_URL` | `http://localhost:8000` | API URL baked into frontend build |

---

## Services

| Service | Port | Description |
|---------|------|-------------|
| `frontend` | `3000` | React dashboard (host network mode — LAN accessible) |
| `api` | `8000` | FastAPI REST + WebSocket |
| `db` | `5432` | PostgreSQL |
| `detector` | — | GPU pipeline (no exposed port) |

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/feed` | GET | Recent notable sightings |
| `/api/leaderboard?period=today\|week\|month\|alltime` | GET | Ranked by score |
| `/api/stats` | GET | Hourly traffic, tier distribution, top makes |
| `/api/live` | GET | 5-min rolling count + latest 5 sightings |
| `/api/status` | GET | Detector health (state, FPS, queue depth) |
| `/api/events` | GET | System event log |
| `/api/control/start` | POST | Start detector `{video_source, source_type, loop}` |
| `/api/control/stop` | POST | Stop detector |
| `/api/control/pause` | POST | Pause frame ingestion |
| `/api/control/resume` | POST | Resume |
| `/api/control/source` | POST | Change video source `{video_source}` |
| `/api/sightings/test` | DELETE | Clear test footage sightings |
| `/api/sightings/all` | DELETE | Clear all sightings |
| `/ws` | WebSocket | Real-time push — sighting events + status every 3s |
| `/crops/{date}/{filename}` | GET | Serve vehicle crop images |

---

## Scoring System

Each vehicle gets a composite coolness score (0–10):

- **Brand tier** (0–4 pts): Hypercar > Supercar > Performance > Premium > Mass market
- **Performance** (0–3 pts): HP and 0–60 time bonuses
- **Rarity** (0–3 pts): Production count (< 100 units = 3 pts)
- **Model bonus** (0–4 pts): Specific models that punch above brand tier (Viper, NSX, GT, etc.)

---

## Admin Panel

The **⚙️ Admin** tab gives you full control:

- **System Status** — state indicator, FPS, frame count, queue depth
- **Tier Distribution** — see how much goes to CLIP vs Haiku vs Sonnet
- **Detector Control** — Start / Pause / Stop, set video source, toggle loop
- **Data Management** — clear test sightings or full reset
- **Event Log** — live scrolling system log (detector state changes, notable cars, errors)

---

## Pi Camera Setup

```bash
# On the Raspberry Pi — install mediamtx and start RTSP stream
cd projects/i35-spotter/pi-camera
bash mediamtx-install.sh
bash stream.sh
```

Stream will be available at `rtsp://PI_IP:8554/cam` at 1920×1080 @ 15fps.

---

## Komodo Deploy

Point Komodo at this repo, set the build context to `projects/i35-spotter/`, and use `docker compose up --build -d` as the deploy command. Set the env vars in Komodo's secret store.

---

## Project Structure

```
i35-spotter/
├── docker-compose.yml
├── .env.example
├── db/
│   ├── schema.sql          # PostgreSQL schema (auto-applied on first boot)
│   └── seed_specs.py       # 90+ exotic/performance car specs
├── detector/
│   ├── main.py             # Main detection loop + control command polling
│   ├── pipeline.py         # 4-tier classification (CLIP → Haiku → Sonnet)
│   ├── scorer.py           # Rule-based coolness scoring (0-10)
│   ├── database.py         # asyncpg DB layer + status writes
│   ├── requirements.txt
│   └── Dockerfile
├── api/
│   ├── main.py             # FastAPI endpoints + WebSocket
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.tsx                      # Global WS connection + tab nav
│   │   └── components/
│   │       ├── LiveFeed.tsx             # Real-time notable vehicle cards
│   │       ├── Leaderboard.tsx          # Top vehicles by period
│   │       ├── StatsPanel.tsx           # Hourly chart + tier dist + brands
│   │       ├── LiveCounter.tsx          # 5-min rolling count
│   │       └── AdminPanel.tsx           # Full admin controls + event log
│   ├── nginx.conf
│   └── Dockerfile
└── pi-camera/
    ├── stream.sh            # libcamera-vid → mediamtx RTSP
    └── mediamtx-install.sh
```
