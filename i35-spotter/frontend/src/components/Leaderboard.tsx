import { useEffect, useState } from "react";

type Period = "today" | "week" | "month" | "alltime";

interface Entry {
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
  notable_reason: string;
  crop_path: string;
}

export default function Leaderboard({ api }: { api: string }) {
  const [period, setPeriod] = useState<Period>("today");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`${api}/api/leaderboard?period=${period}&limit=50`)
      .then((r) => r.json())
      .then((d) => { setEntries(d); setLoading(false); })
      .catch(console.error);
  }, [period]);

  return (
    <div className="max-w-3xl">
      {/* Period tabs */}
      <div className="flex gap-2 mb-6">
        {(["today", "week", "month", "alltime"] as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-3 py-1.5 rounded text-sm capitalize ${
              period === p
                ? "bg-orange-500 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {p === "alltime" ? "All Time" : p}
          </button>
        ))}
      </div>

      {loading && <div className="text-zinc-500 text-sm">Loading...</div>}

      <div className="space-y-2">
        {entries.map((e, i) => {
          const cropUrl = e.crop_path ? `/crops/${e.crop_path}` : null;
          return (
            <div
              key={e.id}
              className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900 p-3"
            >
              {/* Rank */}
              <div className={`w-8 text-center font-bold text-lg flex-shrink-0 ${
                i === 0 ? "text-yellow-400" :
                i === 1 ? "text-zinc-300" :
                i === 2 ? "text-orange-700" :
                "text-zinc-600"
              }`}>
                {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}
              </div>

              {/* Crop */}
              <div className="w-20 h-12 rounded bg-zinc-800 overflow-hidden flex-shrink-0">
                {cropUrl ? (
                  <img src={cropUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-zinc-700 text-xs">—</div>
                )}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="font-bold text-white truncate">
                  {e.make} {e.model}
                  {e.trim && <span className="text-orange-400 ml-1 text-sm">{e.trim}</span>}
                </div>
                <div className="flex gap-3 text-xs text-zinc-500 mt-0.5">
                  {e.hp && <span>⚡{e.hp}hp</span>}
                  {e.zero_to_60 && <span>0-60: {e.zero_to_60}s</span>}
                  {e.production_count && (
                    <span className="text-orange-400">
                      {e.production_count.toLocaleString()} made
                    </span>
                  )}
                </div>
              </div>

              {/* Score */}
              <div className="text-right flex-shrink-0">
                <div className="text-orange-400 font-bold text-lg">
                  {e.score_total.toFixed(1)}
                </div>
                <div className="text-xs text-zinc-600">score</div>
              </div>
            </div>
          );
        })}
        {!loading && entries.length === 0 && (
          <div className="text-zinc-500 text-sm">Nothing spotted yet in this period.</div>
        )}
      </div>
    </div>
  );
}
