"""
I-35 Spotter — main detection loop (4-tier pipeline)

Modes:
  VIDEO_SOURCE=rtsp://...        → live RTSP stream (production)
  VIDEO_SOURCE=/path/to/clip.mp4 → local video file (test mode)
  DRY_RUN=true                   → classify + print, no DB writes

Control:
  The detector polls the control_commands DB table every 2s for admin commands:
    start  — start/restart processing (payload: {video_source, source_type})
    stop   — halt processing
    pause  — pause frame ingestion
    resume — resume from pause
"""

import asyncio
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from ultralytics import YOLO

from database import Database
from pipeline import CarClassificationPipeline
from scorer import score_vehicle

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("spotter")

# ── Environment ───────────────────────────────────────────────────────────────
VIDEO_SOURCE   = os.environ.get("VIDEO_SOURCE") or os.environ.get("RTSP_URL", "")
DB_URL         = os.environ.get("DB_URL", "")
CROPS_PATH     = os.environ.get("CROPS_PATH", "/data/crops")
MIN_SCORE_SAVE = float(os.environ.get("MIN_SCORE_TO_SAVE_CROP", "6"))
DRY_RUN        = "--dry-run" in sys.argv or os.environ.get("DRY_RUN", "").lower() == "true"
LOOP_VIDEO     = os.environ.get("LOOP_VIDEO", "false").lower() == "true"

# ── Detection tuning ──────────────────────────────────────────────────────────
VEHICLE_CLASSES   = [2, 3, 5, 7]   # COCO: car, motorcycle, bus, truck
BBOX_AREA_MIN     = 0.04            # min 4% of frame
BBOX_AREA_MAX     = 0.60            # max 60% of frame
BLUR_THRESHOLD    = 60              # Laplacian variance
CONF_THRESHOLD    = 0.45            # YOLO detection confidence

# ── Globals (mutable via control commands) ────────────────────────────────────
_current_source: str = VIDEO_SOURCE
_paused: bool = False
_stop_requested: bool = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def is_sharp(crop: np.ndarray, threshold: float = BLUR_THRESHOLD) -> bool:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(gray, cv2.CV_64F).var() > threshold


def save_crop(crop: np.ndarray, sighting_id: int) -> str:
    date_str = datetime.now().strftime("%Y%m%d")
    path = Path(CROPS_PATH) / date_str / f"{sighting_id}.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), crop)
    return f"{date_str}/{sighting_id}.jpg"


def source_type(src: str) -> str:
    return "rtsp" if src.startswith("rtsp://") else "test_video"


# ── Vehicle processing ────────────────────────────────────────────────────────

async def process_vehicle(
    crop: np.ndarray,
    track_id: int,
    timestamp: datetime,
    pipeline: CarClassificationPipeline,
    db: Database,
    src: str,
):
    """Classify one tracked vehicle through the 4-tier pipeline and persist."""
    try:
        result = await pipeline.classify(crop)
    except Exception as e:
        logger.error(f"Classification error for track {track_id}: {e}")
        if db:
            await db.log_event("error", "pipeline", f"Classification failed for track {track_id}", {"error": str(e)})
        return

    # Spec lookup
    specs = await db.lookup_specs(result.make, result.model) if db else None
    hp         = specs.get("hp")              if specs else None
    zero_to_60 = specs.get("zero_to_60")      if specs else None
    torque     = specs.get("torque_lb_ft")    if specs else None
    top_speed  = specs.get("top_speed_mph")   if specs else None
    prod_count = specs.get("production_count") if specs else None

    score = score_vehicle(
        make=result.make,
        model=result.model,
        hp=hp,
        zero_to_60=zero_to_60,
        production_count=prod_count,
    )

    is_notable = result.is_notable or score.total >= 6
    stype = source_type(src)

    # ── Dry-run output ────────────────────────────────────────────────────
    if db is None:
        tier_label = {1: "YOLO", 2: "CLIP", 3: "Haiku", 4: "Sonnet"}.get(result.tier, "?")
        label = f"{result.make} {result.model}" + (f" {result.trim}" if result.trim else "")
        print(
            f"{'🔥 ' if is_notable else '   '}"
            f"{label:<38} "
            f"score={score.total:.1f}  "
            f"conf={result.confidence:.0%}  "
            f"T{result.tier}:{tier_label}"
            + (f"  | {result.notable_reason}" if result.notable_reason else "")
        )
        if is_notable:
            out = Path("dry_run_crops") / f"{track_id}_{result.make}_{result.model}.jpg".replace(" ", "_")
            out.parent.mkdir(exist_ok=True)
            cv2.imwrite(str(out), crop)
        return

    # ── DB write ──────────────────────────────────────────────────────────
    if is_notable:
        sighting_id = await db.insert_sighting_partial(
            timestamp=timestamp, make=result.make, model=result.model,
            year_range=result.year_range, trim=result.trim,
            confidence=result.confidence, tier=result.tier,
            hp=hp, torque=torque, zero_to_60=zero_to_60,
            top_speed=top_speed, production_count=prod_count,
            score=score, is_notable=True,
            notable_reason=result.notable_reason,
            source_type=stype, video_source=src,
        )
        crop_path = save_crop(crop, sighting_id)
        await db.update_crop_path(sighting_id, crop_path)
        await db.increment_detector_counts(tier=result.tier, is_notable=True)
        await db.log_event(
            "notable", "pipeline",
            f"🔥 {result.make} {result.model} (score={score.total:.1f} tier={result.tier})",
            {"make": result.make, "model": result.model, "score": score.total,
             "tier": result.tier, "confidence": result.confidence,
             "notable_reason": result.notable_reason}
        )
        logger.info(
            f"🔥 {result.make} {result.model} (score={score.total:.1f}, "
            f"T{result.tier}, conf={result.confidence:.0%})"
        )
    else:
        await db.insert_sighting_full(
            timestamp=timestamp, make=result.make, model=result.model,
            year_range=result.year_range, trim=result.trim,
            confidence=result.confidence, tier=result.tier,
            hp=hp, torque=torque, zero_to_60=zero_to_60,
            top_speed=top_speed, production_count=prod_count,
            score=score, is_notable=False, notable_reason=None, crop_path=None,
            source_type=stype, video_source=src,
        )
        await db.increment_detector_counts(tier=result.tier, is_notable=False)


# ── Control command poller ────────────────────────────────────────────────────

async def control_poller(db: Database):
    """Background task: polls DB for admin control commands."""
    global _current_source, _paused, _stop_requested
    while True:
        await asyncio.sleep(2)
        try:
            cmd = await db.poll_control_command()
            if not cmd:
                continue
            action = cmd["command"]
            payload = cmd.get("payload", {})
            logger.info(f"Control command received: {action} {payload}")

            if action == "stop":
                _stop_requested = True
                await db.update_detector_status(state="stopped")
                await db.log_event("info", "admin", "Stop command received")

            elif action == "start":
                src = payload.get("video_source", _current_source)
                if src:
                    _current_source = src
                _stop_requested = False
                _paused = False
                await db.log_event("info", "admin", f"Start command: source={src}")

            elif action == "pause":
                _paused = True
                await db.update_detector_status(state="paused")
                await db.log_event("info", "admin", "Paused")

            elif action == "resume":
                _paused = False
                await db.update_detector_status(state="running")
                await db.log_event("info", "admin", "Resumed")

            elif action == "set_source":
                src = payload.get("video_source", "")
                if src:
                    _current_source = src
                    _stop_requested = True  # will restart with new source
                    await db.log_event("info", "admin", f"Source changed to {src}")

        except Exception as e:
            logger.error(f"Control poller error: {e}")


# ── Main processing loop ──────────────────────────────────────────────────────

async def run_stream(
    src: str,
    yolo: YOLO,
    tracker: sv.ByteTracker,
    pipeline: CarClassificationPipeline,
    db: Database,
):
    """Process one video source (RTSP or file) until stop/end."""
    global _paused, _stop_requested

    is_file = not src.startswith("rtsp://")
    stype = source_type(src)
    classified_ids: set[int] = set()
    frame_count = 0
    fps_frames = 0
    fps_start = time.monotonic()
    tasks = []
    session_start = datetime.now(timezone.utc)

    if db:
        await db.update_detector_status(
            state="running",
            video_source=src,
            source_type=stype,
            session_start=session_start,
            session_sightings=0,
            session_notable=0,
            tier2_count=0,
            tier3_count=0,
            tier4_count=0,
        )
        await db.log_event("info", "detector", f"Started — source: {src}")

    loop_count = 0

    while True:
        if _stop_requested:
            logger.info("Stop requested — halting")
            break

        loop_count += 1
        logger.info(f"Opening source (loop #{loop_count}): {src}")
        cap = cv2.VideoCapture(src)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)

        if not cap.isOpened():
            msg = f"Cannot open source: {src}"
            logger.error(msg)
            if db:
                await db.update_detector_status(state="error", last_error=msg)
                await db.log_event("error", "detector", msg)
            await asyncio.sleep(5)
            if is_file:
                break
            continue

        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_area = frame_h * frame_w
        logger.info(f"Source open: {frame_w}×{frame_h}")

        while cap.isOpened():
            if _stop_requested:
                break

            # Pause: sleep and poll
            if _paused:
                await asyncio.sleep(0.5)
                continue

            ret, frame = cap.read()
            if not ret:
                if is_file:
                    logger.info("End of file")
                else:
                    logger.warning("Frame read failed")
                break

            frame_count += 1
            fps_frames += 1

            # FPS tracking
            elapsed = time.monotonic() - fps_start
            if elapsed >= 5.0:
                fps = fps_frames / elapsed
                fps_frames = 0
                fps_start = time.monotonic()
                if db:
                    await db.update_detector_status(
                        state="running",
                        fps=fps,
                        frame_count=frame_count,
                        queue_depth=len([t for t in tasks if not t.done()]),
                    )

            # YOLO detection
            results = yolo(
                frame, classes=VEHICLE_CLASSES,
                conf=CONF_THRESHOLD, verbose=False
            )[0]
            detections = sv.Detections.from_ultralytics(results)

            if len(detections) == 0:
                await asyncio.sleep(0)  # yield
                continue

            # ByteTrack
            detections = tracker.update_with_detections(detections)
            timestamp = datetime.now(timezone.utc)

            for i, track_id in enumerate(detections.tracker_id):
                if track_id is None or track_id in classified_ids:
                    continue

                x1, y1, x2, y2 = map(int, detections.xyxy[i])
                bbox_area = (x2 - x1) * (y2 - y1)
                if not (BBOX_AREA_MIN < bbox_area / frame_area < BBOX_AREA_MAX):
                    continue

                crop = frame[y1:y2, x1:x2]
                if crop.size == 0 or not is_sharp(crop):
                    continue

                classified_ids.add(track_id)
                task = asyncio.create_task(
                    process_vehicle(crop.copy(), track_id, timestamp, pipeline, db, src)
                )
                tasks.append(task)

            # Periodic cleanup
            if frame_count % 300 == 0:
                tasks = [t for t in tasks if not t.done()]
                if len(classified_ids) > 50_000:
                    classified_ids = set(list(classified_ids)[-25_000:])

            await asyncio.sleep(0)  # yield to event loop

        cap.release()

        if _stop_requested:
            break
        if is_file and not LOOP_VIDEO:
            logger.info("File processing complete (no loop).")
            if db:
                await db.update_detector_status(state="stopped")
                await db.log_event("info", "detector", "File processing complete")
            break
        if not is_file:
            logger.warning("RTSP disconnected — reconnecting in 3s")
            await asyncio.sleep(3)
        else:
            # Loop video
            logger.info("Looping video...")
            await asyncio.sleep(1)

    # Drain remaining tasks
    if tasks:
        await asyncio.gather(*[t for t in tasks if not t.done()], return_exceptions=True)

    if db:
        await db.update_detector_status(state="stopped")


# ── Entry point ───────────────────────────────────────────────────────────────

async def run():
    global _current_source, _stop_requested

    if DRY_RUN:
        logger.info("DRY RUN mode — results printed, not saved to DB")
        db = None
    elif DB_URL:
        db = Database(DB_URL)
        await db.connect()
    else:
        logger.error("DB_URL not set and DRY_RUN not enabled")
        sys.exit(1)

    # Wait for initial source (from env or admin control command)
    if not _current_source and db:
        logger.info("No VIDEO_SOURCE set — waiting for admin start command...")
        await db.update_detector_status(state="waiting", source_type="rtsp")
        await db.log_event("info", "detector", "Waiting for admin start command")
        while not _current_source and not _stop_requested:
            cmd = await db.poll_control_command()
            if cmd and cmd["command"] == "start":
                src = cmd["payload"].get("video_source", "")
                if src:
                    _current_source = src
            await asyncio.sleep(2)

    pipeline = CarClassificationPipeline()
    yolo = YOLO("yolov8s.pt")
    tracker = sv.ByteTracker(
        track_activation_threshold=0.45,
        lost_track_buffer=60,
        minimum_matching_threshold=0.8,
        frame_rate=30,
    )

    if db:
        await db.log_event("info", "detector", "Pipeline ready (YOLO + CLIP + Haiku + Sonnet)")

    # Start control poller (background task, only with DB)
    control_task = None
    if db:
        control_task = asyncio.create_task(control_poller(db))

    try:
        while True:
            _stop_requested = False
            src = _current_source

            logger.info(f"{'[FILE]' if source_type(src) == 'test_video' else '[RTSP]'} {src}")
            await run_stream(src, yolo, tracker, pipeline, db)

            # After stop: wait for a new start command
            if db:
                await db.update_detector_status(state="stopped")
                logger.info("Detector stopped — waiting for next start command")
                while True:
                    cmd = await db.poll_control_command()
                    if cmd:
                        if cmd["command"] == "start":
                            new_src = cmd["payload"].get("video_source", _current_source)
                            if new_src:
                                _current_source = new_src
                            break
                    await asyncio.sleep(2)
            else:
                break  # dry-run: exit after one run
    finally:
        if control_task:
            control_task.cancel()


if __name__ == "__main__":
    asyncio.run(run())
