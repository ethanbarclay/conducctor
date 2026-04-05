"""
I-35 Spotter API — FastAPI backend

Endpoints:
  GET  /api/feed           — recent notable sightings
  GET  /api/leaderboard    — ranked by score (today/week/month/alltime)
  GET  /api/stats          — dashboard stats (hourly, brands, tier dist)
  GET  /api/live           — 5-min rolling count + latest sightings
  GET  /api/status         — detector health
  GET  /api/events         — recent system event log
  POST /api/control/start  — start detector
  POST /api/control/stop   — stop detector
  POST /api/control/pause  — pause detector
  POST /api/control/resume — resume detector
  POST /api/control/source — change video source
  DELETE /api/sightings/test — clear test sightings
  DELETE /api/sightings/all  — clear all sightings
  WS   /ws                 — real-time push (sightings + status updates)
  GET  /crops/{date}/{fn}  — serve crop images
  GET  /health             — health check
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from typing import Optional, Set

import asyncpg
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s — %(message)s")

app = FastAPI(title="I-35 Spotter API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_URL     = os.environ.get("DB_URL", "")
CROPS_PATH = os.environ.get("CROPS_PATH", "/data/crops")

# ── Connection pool ────────────────────────────────────────────────────────────

_pool: Optional[asyncpg.Pool] = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DB_URL, min_size=2, max_size=15)
    return _pool


@app.on_event("startup")
async def startup():
    await get_pool()
    asyncio.create_task(status_broadcaster())
    logger.info("API ready")


@app.on_event("shutdown")
async def shutdown():
    global _pool
    if _pool:
        await _pool.close()


# ── WebSocket manager ──────────────────────────────────────────────────────────

class ConnectionManager:
    def __init__(self):
        self.active: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self.active.add(ws)

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self.active.discard(ws)

    async def broadcast(self, message: dict):
        data = json.dumps(message, default=str)
        dead = set()
        async with self._lock:
            targets = set(self.active)
        for ws in targets:
            try:
                await ws.send_text(data)
            except Exception:
                dead.add(ws)
        if dead:
            async with self._lock:
                self.active -= dead


ws_manager = ConnectionManager()


async def status_broadcaster():
    """Push detector status to all WS clients every 3 seconds."""
    while True:
        await asyncio.sleep(3)
        try:
            pool = await get_pool()
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT * FROM detector_status WHERE id = 1")
                if row:
                    await ws_manager.broadcast({
                        "type": "status",
                        "data": {
                            k: (v.isoformat() if isinstance(v, datetime) else v)
                            for k, v in dict(row).items()
                        }
                    })
        except Exception as e:
            logger.warning(f"Status broadcaster error: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            # Send current detector status
            status = await conn.fetchrow("SELECT * FROM detector_status WHERE id = 1")
            if status:
                await websocket.send_text(json.dumps({
                    "type": "status",
                    "data": {
                        k: (v.isoformat() if isinstance(v, datetime) else v)
                        for k, v in dict(status).items()
                    }
                }, default=str))
            # Send last 10 notable sightings as initial history
            rows = await conn.fetch(
                """SELECT id, seen_at, make, model, year_range, trim, confidence,
                          classifier_tier, hp, zero_to_60, top_speed_mph, production_count,
                          score_total, is_notable, notable_reason, crop_path
                   FROM sightings WHERE is_notable = TRUE
                   ORDER BY seen_at DESC LIMIT 10"""
            )
            for row in reversed(rows):
                await websocket.send_text(json.dumps({
                    "type": "sighting",
                    "data": {
                        k: (v.isoformat() if isinstance(v, datetime) else v)
                        for k, v in dict(row).items()
                    }
                }, default=str))

        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_text(), timeout=30)
                if msg == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except asyncio.TimeoutError:
                await websocket.send_text(json.dumps({"type": "heartbeat"}))

    except WebSocketDisconnect:
        pass
    finally:
        await ws_manager.disconnect(websocket)


# ── Read endpoints ─────────────────────────────────────────────────────────────

@app.get("/api/feed")
async def get_feed(limit: int = 50, notable_only: bool = True):
    pool = await get_pool()
    async with pool.acquire() as conn:
        where = "WHERE is_notable = TRUE" if notable_only else ""
        rows = await conn.fetch(
            f"""SELECT id, seen_at, make, model, year_range, trim, confidence,
                       classifier_tier, hp, torque_lb_ft, zero_to_60, top_speed_mph,
                       production_count, msrp_usd,
                       score_total, score_rarity, score_performance, score_brand,
                       is_notable, notable_reason, crop_path, source_type
                FROM sightings {where}
                ORDER BY seen_at DESC LIMIT $1""",
            limit
        )
        return [dict(r) for r in rows]


@app.get("/api/leaderboard")
async def get_leaderboard(period: str = "today", limit: int = 25):
    period_filter = {
        "today":   "AND seen_at >= NOW() - INTERVAL '24 hours'",
        "week":    "AND seen_at >= NOW() - INTERVAL '7 days'",
        "month":   "AND seen_at >= NOW() - INTERVAL '30 days'",
        "alltime": "",
    }.get(period, "")
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""SELECT id, seen_at, make, model, year_range, trim, confidence,
                       classifier_tier, hp, torque_lb_ft, zero_to_60, top_speed_mph,
                       production_count, score_total, is_notable, notable_reason, crop_path
                FROM sightings
                WHERE is_notable = TRUE {period_filter}
                ORDER BY score_total DESC LIMIT $1""",
            limit
        )
        return [dict(r) for r in rows]


@app.get("/api/stats")
async def get_stats():
    pool = await get_pool()
    async with pool.acquire() as conn:
        total     = await conn.fetchval("SELECT COUNT(*) FROM sightings")
        notable   = await conn.fetchval("SELECT COUNT(*) FROM sightings WHERE is_notable = TRUE")
        today     = await conn.fetchval("SELECT COUNT(*) FROM sightings WHERE seen_at >= CURRENT_DATE")
        avg_score = await conn.fetchval(
            "SELECT AVG(score_total) FROM sightings WHERE seen_at >= CURRENT_DATE AND score_total IS NOT NULL"
        )
        hourly    = await conn.fetch(
            """SELECT DATE_TRUNC('hour', seen_at) AS hour,
                      COUNT(*) AS total,
                      SUM(CASE WHEN is_notable THEN 1 ELSE 0 END) AS notable
               FROM sightings WHERE seen_at >= NOW() - INTERVAL '24 hours'
               GROUP BY hour ORDER BY hour"""
        )
        top_makes = await conn.fetch(
            """SELECT make, COUNT(*) AS cnt
               FROM sightings
               WHERE make IS NOT NULL AND seen_at >= NOW() - INTERVAL '24 hours'
               GROUP BY make ORDER BY cnt DESC LIMIT 10"""
        )
        tier_dist = await conn.fetch(
            """SELECT classifier_tier AS tier, COUNT(*) AS cnt
               FROM sightings WHERE seen_at >= NOW() - INTERVAL '24 hours'
               GROUP BY classifier_tier ORDER BY classifier_tier"""
        )
        return {
            "total_sightings": total,
            "notable_count": notable,
            "today_count": today,
            "avg_score_today": round(float(avg_score), 2) if avg_score else 0,
            "hourly": [dict(r) for r in hourly],
            "top_makes": [dict(r) for r in top_makes],
            "tier_distribution": [dict(r) for r in tier_dist],
        }


@app.get("/api/live")
async def get_live():
    pool = await get_pool()
    async with pool.acquire() as conn:
        count  = await conn.fetchval(
            "SELECT COUNT(*) FROM sightings WHERE seen_at >= NOW() - INTERVAL '5 minutes'"
        )
        latest = await conn.fetch(
            """SELECT id, seen_at, make, model, trim, score_total,
                      is_notable, crop_path, classifier_tier
               FROM sightings ORDER BY seen_at DESC LIMIT 5"""
        )
        return {"count_5min": count, "latest": [dict(r) for r in latest]}


@app.get("/api/status")
async def get_status():
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM detector_status WHERE id = 1")
        return dict(row) if row else {}


@app.get("/api/events")
async def get_events(limit: int = 50, level: Optional[str] = None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        if level:
            rows = await conn.fetch(
                "SELECT id, event_at, level, category, message, detail FROM system_events WHERE level = $1 ORDER BY event_at DESC LIMIT $2",
                level, limit
            )
        else:
            rows = await conn.fetch(
                "SELECT id, event_at, level, category, message, detail FROM system_events ORDER BY event_at DESC LIMIT $1",
                limit
            )
        return [dict(r) for r in rows]


# ── Control endpoints ──────────────────────────────────────────────────────────

class StartPayload(BaseModel):
    video_source: Optional[str] = None
    source_type: Optional[str] = "rtsp"
    loop: Optional[bool] = False


class SourcePayload(BaseModel):
    video_source: str


async def _issue_command(command: str, payload: dict = None):
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO control_commands (command, payload) VALUES ($1, $2)",
            command, json.dumps(payload or {})
        )


@app.post("/api/control/start")
async def control_start(body: StartPayload):
    await _issue_command("start", {
        "video_source": body.video_source,
        "source_type": body.source_type,
        "loop": body.loop,
    })
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """UPDATE detector_status
               SET state = 'starting', video_source = $1, source_type = $2, updated_at = NOW()
               WHERE id = 1""",
            body.video_source, body.source_type
        )
        await conn.execute(
            "INSERT INTO system_events (level, category, message) VALUES ('info', 'admin', 'Start issued via API')"
        )
    return {"ok": True, "message": "Start command issued"}


@app.post("/api/control/stop")
async def control_stop():
    await _issue_command("stop")
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO system_events (level, category, message) VALUES ('info', 'admin', 'Stop issued via API')"
        )
    return {"ok": True, "message": "Stop command issued"}


@app.post("/api/control/pause")
async def control_pause():
    await _issue_command("pause")
    return {"ok": True, "message": "Pause command issued"}


@app.post("/api/control/resume")
async def control_resume():
    await _issue_command("resume")
    return {"ok": True, "message": "Resume command issued"}


@app.post("/api/control/source")
async def control_set_source(body: SourcePayload):
    stype = "rtsp" if body.video_source.startswith("rtsp://") else "test_video"
    await _issue_command("set_source", {
        "video_source": body.video_source,
        "source_type": stype,
    })
    return {"ok": True, "message": f"Source will change to: {body.video_source}"}


@app.delete("/api/sightings/test")
async def clear_test_sightings():
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM sightings WHERE source_type = 'test_video'"
        )
        await conn.execute("DELETE FROM sightings WHERE source_type = 'test_video'")
        await conn.execute(
            "INSERT INTO system_events (level, category, message, detail) VALUES ('info', 'admin', $1, $2)",
            f"Cleared {count} test sightings",
            json.dumps({"count": int(count)})
        )
    return {"ok": True, "deleted": count}


@app.delete("/api/sightings/all")
async def clear_all_sightings():
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM sightings")
        await conn.execute("DELETE FROM sightings")
        await conn.execute(
            "UPDATE detector_status SET session_sightings = 0, session_notable = 0, tier2_count = 0, tier3_count = 0, tier4_count = 0 WHERE id = 1"
        )
        await conn.execute(
            "INSERT INTO system_events (level, category, message) VALUES ('warn', 'admin', 'All sightings cleared')"
        )
    return {"ok": True, "deleted": count}


# ── Static: crop images ────────────────────────────────────────────────────────

@app.get("/crops/{date}/{filename}")
async def serve_crop(date: str, filename: str):
    path = f"{CROPS_PATH}/{date}/{filename}"
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Crop not found")
    return FileResponse(path, media_type="image/jpeg")


# ── Health check ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "connected"}
    except Exception as e:
        return {"status": "error", "db": str(e)}
