CREATE TABLE IF NOT EXISTS sightings (
    id              BIGSERIAL PRIMARY KEY,
    seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    make            TEXT,
    model           TEXT,
    year_range      TEXT,          -- e.g. "2020-2023"
    trim            TEXT,          -- e.g. "GT3 RS" if detected
    confidence      FLOAT,         -- 0.0-1.0
    classifier_tier INTEGER,       -- 1=YOLO-only, 2=CLIP, 3=Claude Haiku, 4=Claude Sonnet
    -- specs from local DB lookup
    hp              INTEGER,
    torque_lb_ft    INTEGER,
    zero_to_60      FLOAT,         -- seconds
    top_speed_mph   INTEGER,
    production_count INTEGER,      -- NULL = mass produced
    msrp_usd        INTEGER,
    -- scoring
    score_total     FLOAT,         -- 0-10 composite coolness score
    score_rarity    FLOAT,
    score_performance FLOAT,
    score_brand     FLOAT,
    is_notable      BOOLEAN DEFAULT FALSE,
    notable_reason  TEXT,
    -- image
    crop_path       TEXT,          -- NULL for boring cars
    -- raw response
    raw_response    JSONB,
    -- source tracking
    source_type     TEXT DEFAULT 'rtsp',  -- 'rtsp' | 'test_video'
    video_source    TEXT                  -- path or URL
);

CREATE INDEX IF NOT EXISTS idx_sightings_seen_at ON sightings (seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_notable ON sightings (is_notable, seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_sightings_make_model ON sightings (make, model);
CREATE INDEX IF NOT EXISTS idx_sightings_score ON sightings (score_total DESC);

-- Hourly traffic stats (materialized for fast dashboard queries)
CREATE TABLE IF NOT EXISTS hourly_stats (
    hour_bucket     TIMESTAMPTZ PRIMARY KEY,
    total_count     INTEGER DEFAULT 0,
    notable_count   INTEGER DEFAULT 0,
    avg_score       FLOAT,
    top_make        TEXT,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Car specs lookup table (populated by seed_specs.py)
CREATE TABLE IF NOT EXISTS car_specs (
    id              SERIAL PRIMARY KEY,
    make            TEXT NOT NULL,
    model           TEXT NOT NULL,
    year_start      INTEGER,
    year_end        INTEGER,
    hp              INTEGER,
    torque_lb_ft    INTEGER,
    zero_to_60      FLOAT,
    top_speed_mph   INTEGER,
    production_count INTEGER,
    msrp_usd        INTEGER,
    category        TEXT,          -- 'supercar','sports','truck','suv','sedan','exotic'
    rarity_tier     INTEGER,       -- 1=mass market, 2=premium, 3=sports, 4=exotic, 5=hypercar
    UNIQUE(make, model, year_start)
);

CREATE INDEX IF NOT EXISTS idx_specs_make_model ON car_specs (make, model);

-- ── Detector status (one row, upserted by detector) ────────────────────────
CREATE TABLE IF NOT EXISTS detector_status (
    id              INTEGER PRIMARY KEY DEFAULT 1,  -- singleton
    state           TEXT NOT NULL DEFAULT 'stopped', -- 'stopped'|'starting'|'running'|'paused'|'error'
    video_source    TEXT,
    source_type     TEXT DEFAULT 'rtsp',  -- 'rtsp'|'test_video'
    fps             FLOAT DEFAULT 0,
    frame_count     BIGINT DEFAULT 0,
    queue_depth     INTEGER DEFAULT 0,
    -- tier usage counters (reset on start)
    tier2_count     BIGINT DEFAULT 0,
    tier3_count     BIGINT DEFAULT 0,
    tier4_count     BIGINT DEFAULT 0,
    -- current session stats
    session_start   TIMESTAMPTZ,
    session_sightings INTEGER DEFAULT 0,
    session_notable   INTEGER DEFAULT 0,
    -- error info
    last_error      TEXT,
    -- timestamps
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure singleton row exists
INSERT INTO detector_status (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── System event log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_events (
    id          BIGSERIAL PRIMARY KEY,
    event_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level       TEXT NOT NULL DEFAULT 'info',  -- 'info'|'warn'|'error'|'notable'
    category    TEXT,                           -- 'detector'|'pipeline'|'admin'|'db'
    message     TEXT NOT NULL,
    detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_events_at ON system_events (event_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_level ON system_events (level, event_at DESC);

-- ── Control queue (admin → detector) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_commands (
    id          BIGSERIAL PRIMARY KEY,
    issued_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    command     TEXT NOT NULL,   -- 'start'|'stop'|'pause'|'resume'|'set_source'
    payload     JSONB,
    consumed    BOOLEAN DEFAULT FALSE,
    consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ctrl_consumed ON control_commands (consumed, issued_at DESC);
