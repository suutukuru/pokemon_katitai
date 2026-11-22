import { useMemo, useState } from "react";
import { BoardTab } from "./BoardTab";
import { DiagnoseTab } from "./DiagnoseTab";
import { PartyTab } from "./PartyTab";
import { SimTab, type BoardStart } from "./SimTab";
import { loadSaved, type SavedTeam } from "./storage";
import { precomputedIndex } from "./precomputed";
import { allTeams } from "./teams";

type Tab = "party" | "sim" | "board" | "diag";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "party", label: "パーティ", icon: "M4 7h16M4 12h16M4 17h10" },
  { id: "sim", label: "選出分析", icon: "M5 19V9m7 10V5m7 14v-7" },
  { id: "board", label: "対戦盤", icon: "M4 4h16v16H4zM4 12h16M12 4v16" },
  { id: "diag", label: "診断", icon: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v5m0 3v.5" },
];

const pref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const setPref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* unavailable */
  }
};

export function App() {
  const [tab, setTabState] = useState<Tab>(() => pref("ca.tab", "party") as Tab);
  const setTab = (t: Tab) => {
    setTabState(t);
    setPref("ca.tab", t);
    window.scrollTo(0, 0);
  };
  const [saved, setSaved] = useState<SavedTeam[]>(() => loadSaved());
  const teams = useMemo(() => allTeams(saved), [saved]);
  const firstOf = (g: string) => teams.find((t) => t.group === g)?.id ?? teams[0]?.id ?? "";
  const [mineId, setMineRaw] = useState(() => pref("ca.mine", ""));
  const [oppId, setOppRaw] = useState(() => pref("ca.opp", ""));
  // by default, a pair that has precomputed results (instant on a phone)
  const pre = precomputedIndex[0];
  const preMine = pre && teams.find((t) => t.group === "mine" && t.name === pre.team)?.id;
  const preOpp = pre && teams.find((t) => t.metaId === pre.opponent)?.id;
  const mine = teams.some((t) => t.id === mineId) ? mineId : (preMine ?? firstOf("mine"));
  const opp = teams.some((t) => t.id === oppId) ? oppId : (preOpp ?? firstOf("meta"));
  const setMine = (id: string) => (setMineRaw(id), setPref("ca.mine", id));
  const setOpp = (id: string) => (setOppRaw(id), setPref("ca.opp", id));
  const [start, setStart] = useState<BoardStart | null>(null);
  const regulationId = "M-C";

  const common = {
    teams,
    regulationId,
    mineId: mine,
    setMineId: setMine,
    oppId: opp,
    setOppId: setOpp,
  };
  return (
    <div className="app">
      <header className="topbar">
        <h1>Champions Analyzer</h1>
        <span className="muted small">{regulationId}</span>
      </header>
      <main>
        {tab === "party" && <PartyTab {...common} saved={saved} setSaved={setSaved} />}
        {tab === "sim" && (
          <SimTab
            {...common}
            onOpenBoard={(s) => {
              setStart(s);
              setTab("board");
            }}
          />
        )}
        {/* the board stays mounted so a game in progress survives tab switches */}
        <div hidden={tab !== "board"}>
          <BoardTab {...common} start={start} setStart={setStart} />
        </div>
        {tab === "diag" && <DiagnoseTab saved={saved} setSaved={setSaved} />}
        <footer className="muted small">
          非公式のファン作成ツールです。ゲーム内の画像・ロゴは使用していません。数値はシミュレーションによる推定を含みます。
        </footer>
      </main>
      <nav className="tabbar" aria-label="画面">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={t.icon} />
            </svg>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
