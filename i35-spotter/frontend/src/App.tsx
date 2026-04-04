import { useEffect, useState, useRef, useCallback } from "react";
import LiveFeed from "./components/LiveFeed";
import Leaderboard from "./components/Leaderboard";
import StatsPanel from "./components/StatsPanel";
import LiveCounter from "./components/LiveCounter";
import AdminPanel from "./components/AdminPanel";

const API    = import.meta.env.VITE_API_URL || "http://localhost:8000";
const WS_URL = API.replace(/^http/, "ws") + "/ws";

type Tab = "feed" | "leaderboard" | "stats" | "admin";

const TABS: { id: Tab; label: string }[] = [
  { id: "feed",        label: "🔴 Live Feed"   },
  { id: "leaderboard", label: "🏆 Leaderboard" },
  { id: "stats",       label: "📊 Stats"       },
  { id: "admin",       label: "⚙️ Admin"       },
];

function WsStatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      title={connected ? "WebSocket connected" : "WebSocket disconnected"}
      className={`inline-block w-2 h-2 rounded-full ml-2 ${connected ? "bg-green-400 animate-pulse" : "bg-red-500"}`}
    />
  );
}

export default function App() {
  const [tab, setTab]         = useState<Tab>("feed");
  const [wsOk, setWsOk]       = useState(false);
  const wsRef                  = useRef<WebSocket | null>(null);
  const reconnectTimer         = useRef<ReturnType<typeof setTimeout>>();

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen  = () => { setWsOk(true);  clearTimeout(reconnectTimer.current); };
    ws.onclose = () => {
      setWsOk(false);
      reconnectTimer.current = setTimeout(connectWs, 4000);
    };
    ws.onerror = () => ws.close();

    // Keep-alive ping every 25s
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 25_000);
    ws.onclose = () => {
      clearInterval(ping);
      setWsOk(false);
      reconnectTimer.current = setTimeout(connectWs, 4000);
    };
  }, []);

  useEffect(() => {
    connectWs();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connectWs]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white font-mono">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-1">
            🚗 I-35 Spotter
            <WsStatusDot connected={wsOk} />
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Live vehicle intelligence · Austin, TX · I-35 Southbound
          </p>
        </div>
        <LiveCounter api={API} />
      </header>

      {/* Nav */}
      <nav className="border-b border-zinc-800 px-6 flex gap-6">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`py-3 text-sm border-b-2 transition-colors ${
              tab === id
                ? "border-orange-500 text-orange-400"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <main className="p-6">
        {tab === "feed"        && <LiveFeed    api={API} wsRef={wsRef} />}
        {tab === "leaderboard" && <Leaderboard api={API} />}
        {tab === "stats"       && <StatsPanel  api={API} />}
        {tab === "admin"       && <AdminPanel  api={API} wsRef={wsRef} />}
      </main>
    </div>
  );
}
