"""Database layer — asyncpg-backed PostgreSQL client."""

import logging
import json
from datetime import datetime, timezone
from typing import Optional, Any
import asyncpg
from scorer import Score

logger = logging.getLogger(__name__)


class Database:
    def __init__(self, url: str):
        self.url = url
        self.pool: Optional[asyncpg.Pool] = None

    async def connect(self):
        self.pool = await asyncpg.create_pool(self.url, min_size=2, max_size=10)
        logger.info("DB pool established")
        await self.log_event("info", "db", "Database pool established")

    # ── Car specs lookup ───────────────────────────────────────────────────

    async def lookup_specs(self, make: Optional[str], model: Optional[str]) -> Optional[dict]:
        if not make or not self.pool:
            return None
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT hp, torque_lb_ft, zero_to_60, top_speed_mph,
                          production_count, msrp_usd, rarity_tier
                   FROM car_specs
                   WHERE lower(make) = lower($1)
                     AND lower(model) ILIKE lower($2) || '%'
                   ORDER BY year_start DESC
                   LIMIT 1""",
                make, model or ""
            )
            return dict(row) if row else None

    # ── Sightings ──────────────────────────────────────────────────────────

    async def insert_sighting_partial(
        self, *, timestamp, make, model, year_range, trim,
        confidence, tier, hp, torque, zero_to_60, top_speed,
        production_count, score: Score, is_notable, notable_reason,
        source_type: str = "rtsp", video_source: str = None
    ) -> int:
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """INSERT INTO sightings
                   (seen_at, make, model, year_range, trim, confidence,
                    classifier_tier, hp, torque_lb_ft, zero_to_60, top_speed_mph,
                    production_count, score_total, score_rarity, score_performance,
                    score_brand, is_notable, notable_reason, source_type, video_source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                   RETURNING id""",
                timestamp, make, model, year_range, trim, confidence,
                tier, hp, torque, zero_to_60, top_speed,
                production_count, score.total, score.rarity,
                score.performance, score.brand, is_notable, notable_reason,
                source_type, video_source
            )
            return row["id"]

    async def update_crop_path(self, sighting_id: int, path: str):
        async with self.pool.acquire() as conn:
            await conn.execute(
                "UPDATE sightings SET crop_path = $1 WHERE id = $2",
                path, sighting_id
            )

    async def insert_sighting_full(
        self, *, timestamp, make, model, year_range, trim,
        confidence, tier, hp, torque, zero_to_60, top_speed,
        production_count, score: Score, is_notable, notable_reason, crop_path,
        source_type: str = "rtsp", video_source: str = None
    ):
        async with self.pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO sightings
                   (seen_at, make, model, year_range, trim, confidence,
                    classifier_tier, hp, torque_lb_ft, zero_to_60, top_speed_mph,
                    production_count, score_total, score_rarity, score_performance,
                    score_brand, is_notable, notable_reason, crop_path,
                    source_type, video_source)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)""",
                timestamp, make, model, year_range, trim, confidence,
                tier, hp, torque, zero_to_60, top_speed,
                production_count, score.total, score.rarity,
                score.performance, score.brand, is_notable, notable_reason, crop_path,
                source_type, video_source
            )

    # ── Detector status ────────────────────────────────────────────────────

    async def update_detector_status(
        self, *,
        state: str,
        video_source: str = None,
        source_type: str = "rtsp",
        fps: float = 0,
        frame_count: int = None,
        queue_depth: int = 0,
        tier2_count: int = None,
        tier3_count: int = None,
        tier4_count: int = None,
        session_start: datetime = None,
        session_sightings: int = None,
        session_notable: int = None,
        last_error: str = None,
    ):
        if not self.pool:
            return
        async with self.pool.acquire() as conn:
            # Build dynamic update
            fields = [
                "state = $2", "updated_at = NOW()",
                "fps = $3", "queue_depth = $4",
            ]
            params: list[Any] = [1, state, fps, queue_depth]
            idx = 5

            def add(field, val):
                nonlocal idx
                if val is not None:
                    fields.append(f"{field} = ${idx}")
                    params.append(val)
                    idx += 1

            add("video_source", video_source)
            add("source_type", source_type)
            add("frame_count", frame_count)
            add("tier2_count", tier2_count)
            add("tier3_count", tier3_count)
            add("tier4_count", tier4_count)
            add("session_start", session_start)
            add("session_sightings", session_sightings)
            add("session_notable", session_notable)
            add("last_error", last_error)

            sql = f"UPDATE detector_status SET {', '.join(fields)} WHERE id = $1"
            await conn.execute(sql, *params)

    async def increment_detector_counts(self, *, tier: int, is_notable: bool):
        """Atomically bump tier counters and session sightings."""
        if not self.pool:
            return
        tier_col = {2: "tier2_count", 3: "tier3_count", 4: "tier4_count"}.get(tier)
        if not tier_col:
            return
        async with self.pool.acquire() as conn:
            await conn.execute(
                f"""UPDATE detector_status
                    SET {tier_col} = {tier_col} + 1,
                        session_sightings = session_sightings + 1,
                        session_notable = session_notable + (CASE WHEN $1 THEN 1 ELSE 0 END),
                        updated_at = NOW()
                    WHERE id = 1""",
                is_notable
            )

    # ── System event log ───────────────────────────────────────────────────

    async def log_event(
        self, level: str, category: str, message: str,
        detail: dict = None
    ):
        if not self.pool:
            logger.debug(f"[{level}] {category}: {message}")
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO system_events (level, category, message, detail)
                       VALUES ($1, $2, $3, $4)""",
                    level, category, message,
                    json.dumps(detail) if detail else None
                )
        except Exception as e:
            logger.warning(f"Failed to log event: {e}")

    # ── Control command queue ──────────────────────────────────────────────

    async def poll_control_command(self) -> Optional[dict]:
        """Fetch and consume oldest pending control command."""
        if not self.pool:
            return None
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                """UPDATE control_commands
                   SET consumed = TRUE, consumed_at = NOW()
                   WHERE id = (
                     SELECT id FROM control_commands
                     WHERE consumed = FALSE
                     ORDER BY issued_at ASC
                     LIMIT 1
                     FOR UPDATE SKIP LOCKED
                   )
                   RETURNING id, command, payload"""
            )
            if row:
                return {"id": row["id"], "command": row["command"],
                        "payload": dict(row["payload"]) if row["payload"] else {}}
            return None

    async def get_detector_status(self) -> Optional[dict]:
        if not self.pool:
            return None
        async with self.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM detector_status WHERE id = 1")
            return dict(row) if row else None
