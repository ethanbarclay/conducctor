import { useEffect, useState } from "react";

interface Stats {
  total_sightings: number;
  notable_count: number;
  today_count: number;
  avg_score_today: number;
  top_makes: { make: string; cnt: number }[];
  hourly: { hour: string; total: number; notable: number }[];
  tier_distribution: { tier: number; cnt: number }[];
}

const TIER_NAMES: Record<number, string> = {
  1: "T1 YOLO", 2: "T2 CLIP", 3: "T3 Haiku", 4: "T4 Sonnet"
};

const TIER_COLORS: Record<number, string> = {
  2: "bg-blue-500", 3: "bg-yellow-500", 4: "bg-orange-500"
};

export default function StatsPanel({ api }: { api: string }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const load = () =>
      fetch(`${api}/api/stats`)
        .then((r) => r.json())
        .then(setStats)
        .catch(console.error);
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  if (!stats) return <div className="text-zinc-500 text-sm">Loading stats...</div>;

  const maxHourly = Math.max(...(stats.hourly || []).map((h) => h.total), 1);

  return (
    <div className="max-w-2xl space-y-8">
      {/* Top KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Total Sightings", value: stats.total_sightings?.toLocaleString() ?? "0" },
          { label: "Notable",         value: stats.notable_count?.toLocaleString() ?? "0" },
          { label: "Today",           value: stats.today_count?.toLocaleString() ?? "0" },
          { label: "Avg Score Today", value: stats.avg_score_today?.toFixed(1) ?? "0.0" },
        ].map((s) => (
          <div key={s.label} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
            <div className="text-2xl font-bold text-orange-400">{s.value}</div>
            <div className="text-xs text-zinc-500 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Hourly chart */}
      <div>
        <h3 className="text-sm text-zinc-400 mb-3 font-semibold uppercase tracking-wider">
          Traffic — Last 24h
        </h3>
        {stats.hourly.length === 0 ? (
          <div className="text-zinc-600 text-sm">No data yet.</div>
        ) : (
          <>
            <div className="flex items-end gap-1 h-24">
              {stats.hourly.map((h) => {
                const pct = (h.total / maxHourly) * 100;
                const notablePct = (h.notable / maxHourly) * 100;
                const hour = new Date(h.hour).getHours();
                return (
                  <div
                    key={h.hour}
                    className="flex-1 flex flex-col items-center gap-0.5"
                    title={`${hour}:00 — ${h.total} vehicles (${h.notable} notable)`}
                  >
                    <div className="w-full relative" style={{ height: "80px" }}>
                      <div className="absolute bottom-0 w-full bg-zinc-700 rounded-sm" style={{ height: `${pct}%` }} />
                      <div className="absolute bottom-0 w-full bg-orange-500 rounded-sm" style={{ height: `${notablePct}%` }} />
                    </div>
                    {hour % 6 === 0 && (
                      <div className="text-zinc-600" style={{ fontSize: "8px" }}>{hour}h</div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-4 mt-2 text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-orange-500 rounded-sm inline-block" /> Notable
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-zinc-700 rounded-sm inline-block" /> All
              </span>
            </div>
          </>
        )}
      </div>

      {/* Tier distribution */}
      {stats.tier_distribution?.length > 0 && (
        <div>
          <h3 className="text-sm text-zinc-400 mb-3 font-semibold uppercase tracking-wider">
            Classifier Tier Distribution (Today)
          </h3>
          <div className="flex gap-3 flex-wrap">
            {stats.tier_distribution.map(({ tier, cnt }) => {
              const total = stats.tier_distribution.reduce((a, t) => a + t.cnt, 0);
              const pct = total > 0 ? ((cnt / total) * 100).toFixed(1) : "0";
              return (
                <div key={tier} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 min-w-28">
                  <div className="text-xs text-zinc-500">{TIER_NAMES[tier] || `Tier ${tier}`}</div>
                  <div className="text-xl font-bold text-white mt-0.5">{cnt.toLocaleString()}</div>
                  <div className="mt-1.5 h-1 rounded bg-zinc-800">
                    <div
                      className={`h-full rounded ${TIER_COLORS[tier] || "bg-zinc-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="text-xs text-zinc-600 mt-0.5">{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top makes */}
      <div>
        <h3 className="text-sm text-zinc-400 mb-3 font-semibold uppercase tracking-wider">
          Top Makes (Today)
        </h3>
        {stats.top_makes.length === 0 ? (
          <div className="text-zinc-600 text-sm">No data yet.</div>
        ) : (
          <div className="space-y-2">
            {stats.top_makes.map((m) => {
              const maxCnt = stats.top_makes[0]?.cnt || 1;
              const pct = (m.cnt / maxCnt) * 100;
              return (
                <div key={m.make} className="flex items-center gap-3">
                  <div className="w-28 text-sm text-zinc-300 truncate">{m.make || "Unknown"}</div>
                  <div className="flex-1 bg-zinc-800 rounded-full h-2">
                    <div className="bg-orange-500 h-2 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-xs text-zinc-500 w-10 text-right">
                    {m.cnt.toLocaleString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
