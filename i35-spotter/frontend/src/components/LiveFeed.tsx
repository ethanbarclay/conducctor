import React, { useEffect, useState, useRef } from "react";

export interface Sighting {
  id: number;
  seen_at: string;
  make: string;
  model: string;
  year_range: string;
  trim: string;
  score_total: number;
  hp: number;
  zero_to_60: number;
  top_speed_mph: number;
  production_count: number;
  is_notable: boolean;
  notable_reason: string;
  crop_path: string;
  classifier_tier: number;
  source_type: string;
}

const TIER_LABEL: Record<number, string> = {
  1: "YOLO", 2: "CLIP", 3: "Haiku", 4: "Sonnet"
};

const TIER_COLOR: Record<number, string> = {
  2: "bg-blue-900 text-blue-300",
  3: "bg-yellow-900 text-yellow-300",
  4: "bg-orange-900 text-orange-300",
};

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 8 ? "bg-orange-500 text-white" :
    score >= 6 ? "bg-yellow-500 text-black" :
    "bg-zinc-700 text-zinc-300";
  return (
    <span className={`text-xs font-bold px-2 py-0.5 rounded ${color}`}>
      {score?.toFixed(1) ?? "—"}
    </span>
  );
}

export function VehicleCard({ s, flash = false }: { s: Sighting; flash?: boolean }) {
  const [highlight, setHighlight] = useState(flash);
  const time = new Date(s.seen_at).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const cropUrl = s.crop_path ? `/crops/${s.crop_path}` : null;
  const tierLabel = TIER_LABEL[s.classifier_tier] || "—";
  const tierColor = TIER_COLOR[s.classifier_tier] || "bg-zinc-800 text-zinc-400";

  useEffect(() => {
    if (flash) {
      setHighlight(true);
      const t = setTimeout(() => setHighlight(false), 2500);
      return () => clearTimeout(t);
    }
  }, [flash]);

  return (
    <div className={`rounded-lg border p-4 flex gap-4 transition-all duration-500 ${
      highlight
        ? "border-orange-400 bg-orange-950/30 shadow-lg shadow-orange-950/30"
        : s.score_total >= 8
          ? "border-orange-500/60 bg-orange-950/20"
          : "border-zinc-800 bg-zinc-900"
    }`}>
      {/* Crop image */}
      <div className="w-32 h-20 rounded bg-zinc-800 overflow-hidden flex-shrink-0">
        {cropUrl ? (
          <img src={cropUrl} alt={`${s.make} ${s.model}`}
               className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-zinc-600 text-xs">
            no image
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-bold text-white">
              {s.make} {s.model}
              {s.trim && <span className="text-orange-400 ml-1">{s.trim}</span>}
            </div>
            {s.year_range && (
              <div className="text-xs text-zinc-500">{s.year_range}</div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-xs px-1.5 py-0.5 rounded ${tierColor}`}>T{s.classifier_tier}</span>
            <ScoreBadge score={s.score_total} />
          </div>
        </div>

        {/* Specs row */}
        <div className="flex gap-4 mt-2 text-xs text-zinc-400">
          {s.hp && <span>⚡ {s.hp} hp</span>}
          {s.zero_to_60 && <span>0-60: {s.zero_to_60}s</span>}
          {s.top_speed_mph && <span>🏁 {s.top_speed_mph} mph</span>}
          {s.production_count && <span>#{s.production_count.toLocaleString()} made</span>}
        </div>

        {s.notable_reason && (
          <div className="mt-1 text-xs text-orange-400 italic">
            {s.notable_reason}
          </div>
        )}

        {s.source_type === "test_video" && (
          <div className="mt-1 text-xs text-blue-500">📹 test footage</div>
        )}
      </div>

      <div className="text-xs text-zinc-600 flex-shrink-0">{time}</div>
    </div>
  );
}

export default function LiveFeed({
  api,
  wsRef,
}: {
  api: string;
  wsRef: React.MutableRefObject<WebSocket | null>;
}) {
  const [sightings, setSightings] = useState<Sighting[]>([]);
  const [loading, setLoading]   = useState(true);
  const [newIds, setNewIds]     = useState<Set<number>>(new Set());
  const wsConnected              = useRef(false);

  // Initial load
  const fetchFeed = async () => {
    try {
      const res  = await fetch(`${api}/api/feed?limit=40`);
      const data: Sighting[] = await res.json();
      setSightings(data);
      setLoading(false);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchFeed();
  }, []);

  // WebSocket: listen for new sightings pushed from server
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const handler = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "sighting") {
          const s = msg.data as Sighting;
          if (!s.is_notable) return;
          setSightings((prev) => {
            if (prev.find((x) => x.id === s.id)) return prev;
            return [s, ...prev].slice(0, 60);
          });
          setNewIds((prev) => new Set(prev).add(s.id));
          setTimeout(() => {
            setNewIds((prev) => {
              const next = new Set(prev);
              next.delete(s.id);
              return next;
            });
          }, 3000);
        }
      } catch {}
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [wsRef.current]);

  if (loading) return <div className="text-zinc-500 text-sm">Loading feed...</div>;

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="text-xs text-zinc-600 mb-4">
        Notable vehicles only · live via WebSocket
      </div>
      {sightings.length === 0 && (
        <div className="text-zinc-500 text-sm">No notable vehicles spotted yet.</div>
      )}
      {sightings.map((s) => (
        <VehicleCard key={s.id} s={s} flash={newIds.has(s.id)} />
      ))}
    </div>
  );
}
