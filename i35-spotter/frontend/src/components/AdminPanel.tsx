import React, { useEffect, useState, useRef } from "react";

interface DetectorStatus {
  state: string;
  video_source: string | null;
  source_type: string;
  fps: number;
  frame_count: number;
  queue_depth: number;
  tier2_count: number;
  tier3_count: number;
  tier4_count: number;
  session_start: string | null;
  session_sightings: number;
  session_notable: number;
  last_error: string | null;
  updated_at: string;
}

interface SystemEvent {
  id: number;
  event_at: string;
  level: string;
  category: string;
  message: string;
}

const STATE_COLOR: Record<string, string> = {
  running:  "bg-green-500",
  starting: "bg-yellow-500",
  stopped:  "bg-zinc-600",
  paused:   "bg-blue-500",
  waiting:  "bg-purple-500",
  error:    "bg-red-500",
};

const LEVEL_COLOR: Record<string, string> = {
  info:    "text-zinc-400",
  warn:    "text-yellow-400",
  error:   "text-red-400",
  notable: "text-orange-400",
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-zinc-600 mt-1">{sub}</div>}
    </div>
  );
}

export default function AdminPanel({ api, wsRef }: { api: string; wsRef: React.MutableRefObject<WebSocket | null> }) {
  const [status, setStatus] = useState<DetectorStatus | null>(null);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [videoInput, setVideoInput] = useState("");
  const [loopVideo, setLoopVideo] = useState(true);
  const [cmdLoading, setCmdLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const eventsRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  // Poll status + events
  const fetchData = async () => {
    try {
      const [sRes, eRes] = await Promise.all([
        fetch(`${api}/api/status`),
        fetch(`${api}/api/events?limit=30`),
      ]);
      if (sRes.ok) setStatus(await sRes.json());
      if (eRes.ok) setEvents(await eRes.json());
    } catch (e) {
      console.error("Admin fetch error:", e);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 4000);
    return () => clearInterval(interval);
  }, []);

  // Listen for status updates from WS
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "status") setStatus(msg.data as DetectorStatus);
      } catch {}
    };
    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [wsRef.current]);

  // Scroll events to bottom when new ones arrive
  useEffect(() => {
    if (eventsRef.current) {
      eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
    }
  }, [events]);

  const post = async (path: string, body?: object) => {
    const res = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };

  const del = async (path: string) => {
    const res = await fetch(`${api}${path}`, { method: "DELETE" });
    return res.json();
  };

  const handleStart = async () => {
    setCmdLoading("start");
    try {
      const src = videoInput.trim() || undefined;
      const stype = src ? (src.startsWith("rtsp://") ? "rtsp" : "test_video") : "rtsp";
      await post("/api/control/start", {
        video_source: src,
        source_type: stype,
        loop: loopVideo,
      });
      showToast("▶ Start command sent");
      await fetchData();
    } catch (e) {
      showToast("Failed to send start command", false);
    } finally {
      setCmdLoading(null);
    }
  };

  const handleStop = async () => {
    setCmdLoading("stop");
    try {
      await post("/api/control/stop");
      showToast("⏹ Stop command sent");
    } catch (e) {
      showToast("Failed to send stop command", false);
    } finally {
      setCmdLoading(null);
    }
  };

  const handlePause = async () => {
    setCmdLoading("pause");
    try {
      const isPaused = status?.state === "paused";
      await post(isPaused ? "/api/control/resume" : "/api/control/pause");
      showToast(isPaused ? "▶ Resume sent" : "⏸ Pause sent");
    } catch (e) {
      showToast("Failed", false);
    } finally {
      setCmdLoading(null);
    }
  };

  const handleClearTest = async () => {
    if (!confirm("Delete all test_video sightings?")) return;
    setCmdLoading("clear_test");
    try {
      const res = await del("/api/sightings/test");
      showToast(`🗑 Cleared ${res.deleted} test sightings`);
      await fetchData();
    } catch {
      showToast("Failed to clear", false);
    } finally {
      setCmdLoading(null);
    }
  };

  const handleClearAll = async () => {
    if (!confirm("⚠️ Delete ALL sightings? This cannot be undone.")) return;
    setCmdLoading("clear_all");
    try {
      const res = await del("/api/sightings/all");
      showToast(`🗑 Cleared ${res.deleted} total sightings`);
    } catch {
      showToast("Failed to clear", false);
    } finally {
      setCmdLoading(null);
    }
  };

  const stateColor = STATUS_COLOR(status?.state || "stopped");
  const isRunning  = status?.state === "running";
  const isPaused   = status?.state === "paused";
  const totalTier  = (status?.tier2_count || 0) + (status?.tier3_count || 0) + (status?.tier4_count || 0);

  return (
    <div className="max-w-5xl space-y-6">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-all
          ${toast.ok ? "bg-green-900 border border-green-600 text-green-200" : "bg-red-900 border border-red-600 text-red-200"}`}>
          {toast.msg}
        </div>
      )}

      {/* ── System Status ── */}
      <section>
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">System Status</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="State" value={status?.state || "—"}
            sub={status?.updated_at ? `updated ${new Date(status.updated_at).toLocaleTimeString()}` : undefined} />
          <StatCard label="FPS" value={status?.fps?.toFixed(1) || "0.0"}
            sub={`${status?.frame_count?.toLocaleString() || 0} frames`} />
          <StatCard label="Session Sightings" value={status?.session_sightings || 0}
            sub={`${status?.session_notable || 0} notable`} />
          <StatCard label="Queue Depth" value={status?.queue_depth || 0}
            sub="pending classification tasks" />
        </div>

        {/* Status indicator + source */}
        <div className="mt-3 flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
          <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATE_COLOR[status?.state || "stopped"] || "bg-zinc-600"}`} />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium capitalize text-white">{status?.state || "stopped"}</span>
            {status?.video_source && (
              <span className="ml-3 text-xs text-zinc-500 truncate">{status.video_source}</span>
            )}
          </div>
          {status?.source_type && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              status.source_type === "test_video" ? "bg-blue-900 text-blue-300" : "bg-green-900 text-green-300"
            }`}>
              {status.source_type === "test_video" ? "TEST FILE" : "RTSP LIVE"}
            </span>
          )}
        </div>

        {status?.last_error && (
          <div className="mt-2 bg-red-950/40 border border-red-800 rounded px-3 py-2 text-xs text-red-300">
            ⚠️ {status.last_error}
          </div>
        )}
      </section>

      {/* ── Tier Distribution ── */}
      {totalTier > 0 && (
        <section>
          <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Pipeline Tier Distribution</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="flex gap-4 flex-wrap">
              {[
                { label: "T2 CLIP",   count: status?.tier2_count || 0,  color: "bg-blue-500" },
                { label: "T3 Haiku",  count: status?.tier3_count || 0,  color: "bg-yellow-500" },
                { label: "T4 Sonnet", count: status?.tier4_count || 0,  color: "bg-orange-500" },
              ].map(({ label, count, color }) => {
                const pct = totalTier > 0 ? (count / totalTier) * 100 : 0;
                return (
                  <div key={label} className="flex-1 min-w-24">
                    <div className="text-xs text-zinc-500 mb-1">{label}</div>
                    <div className="text-lg font-bold text-white">{count.toLocaleString()}</div>
                    <div className="mt-1 h-1.5 rounded bg-zinc-800">
                      <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-xs text-zinc-600 mt-0.5">{pct.toFixed(1)}%</div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* ── Detector Control ── */}
      <section>
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Detector Control</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">

          {/* Video source input */}
          <div>
            <label className="text-xs text-zinc-400 block mb-1">
              Video Source <span className="text-zinc-600">(blank = use env VIDEO_SOURCE)</span>
            </label>
            <input
              type="text"
              value={videoInput}
              onChange={(e) => setVideoInput(e.target.value)}
              placeholder="rtsp://192.168.1.x:8554/cam  or  /data/test.mov"
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-orange-500"
            />
            <div className="flex items-center gap-2 mt-2">
              <input
                type="checkbox"
                id="loopVideo"
                checked={loopVideo}
                onChange={(e) => setLoopVideo(e.target.checked)}
                className="accent-orange-500"
              />
              <label htmlFor="loopVideo" className="text-xs text-zinc-400">Loop video file</label>
            </div>
          </div>

          {/* Control buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleStart}
              disabled={!!cmdLoading}
              className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
            >
              {cmdLoading === "start" ? "⏳" : "▶"} Start
            </button>
            <button
              onClick={handlePause}
              disabled={!!cmdLoading || (!isRunning && !isPaused)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
            >
              {cmdLoading === "pause" ? "⏳" : isPaused ? "▶" : "⏸"} {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={handleStop}
              disabled={!!cmdLoading || status?.state === "stopped"}
              className="flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors"
            >
              {cmdLoading === "stop" ? "⏳" : "⏹"} Stop
            </button>
          </div>
        </div>
      </section>

      {/* ── Data Management ── */}
      <section>
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">Data Management</h2>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleClearTest}
              disabled={!!cmdLoading}
              className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-sm text-white rounded transition-colors"
            >
              {cmdLoading === "clear_test" ? "⏳" : "🗑"} Clear Test Sightings
            </button>
            <button
              onClick={handleClearAll}
              disabled={!!cmdLoading}
              className="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 text-sm text-red-200 rounded transition-colors border border-red-700"
            >
              {cmdLoading === "clear_all" ? "⏳" : "⚠️"} Clear ALL Sightings
            </button>
          </div>
        </div>
      </section>

      {/* ── Event Log ── */}
      <section>
        <h2 className="text-sm font-bold text-zinc-400 uppercase tracking-wider mb-3">System Event Log</h2>
        <div
          ref={eventsRef}
          className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800 max-h-80 overflow-y-auto"
        >
          {events.length === 0 && (
            <div className="px-4 py-3 text-xs text-zinc-600">No events yet.</div>
          )}
          {events.map((e) => (
            <div key={e.id} className="px-4 py-2 flex gap-3 items-start">
              <span className={`text-xs font-mono flex-shrink-0 ${LEVEL_COLOR[e.level] || "text-zinc-400"}`}>
                {e.level.toUpperCase()}
              </span>
              <span className="text-xs text-zinc-600 flex-shrink-0 w-20">
                {e.category}
              </span>
              <span className="text-xs text-zinc-300 flex-1">{e.message}</span>
              <span className="text-xs text-zinc-600 flex-shrink-0">
                {new Date(e.event_at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function STATUS_COLOR(state: string) {
  return STATE_COLOR[state] || "bg-zinc-600";
}
