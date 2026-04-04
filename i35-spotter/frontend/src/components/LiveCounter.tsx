import { useEffect, useState } from "react";

export default function LiveCounter({ api }: { api: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [pulse, setPulse]  = useState(false);

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const r = await fetch(`${api}/api/live`);
        const d = await r.json();
        setCount(d.count_5min ?? 0);
        setPulse(true);
        setTimeout(() => setPulse(false), 300);
      } catch {}
    };
    fetchCount();
    const iv = setInterval(fetchCount, 5000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="text-right">
      <div className={`text-lg font-bold transition-colors ${pulse ? "text-orange-400" : "text-zinc-300"}`}>
        {count !== null ? count.toLocaleString() : "—"}
      </div>
      <div className="text-xs text-zinc-600">vehicles / 5 min</div>
    </div>
  );
}
