import { useEffect, useMemo, useRef, useState } from "react";
import type { PokemonSet } from "@ca/schema";
import type { Config, MatchupAnalysis, PositionAnalysis } from "@ca/sim";
import { loadSession, poolFor, useSession } from "./engine/useEngine";
import type { Preset } from "./engine/session";
import { findPrecomputed, loadPrecomputed, type PrecomputedMatchup } from "./precomputed";
import type { TeamEntry } from "./teams";
import { BringNames, EvalSpark, RateBar } from "./ui/bits";
import { pct, slotText } from "./ui/format";
import { TeamPicker } from "./ui/TeamPicker";

export interface BoardStart {
  mine: PokemonSet[];
  theirs: PokemonSet[];
  mineName: string;
  theirName: string;
  ca: Config;
  cb: Config;
  seed: number;
  /** analyses known in advance (precomputed best-play line), by position key */
  positions?: Record<string, PositionAnalysis>;
}

const CACHE_KEY = "ca.sim.v1";
interface Cached {
  key: string;
  a: MatchupAnalysis;
}
function readCache(): Cached[] {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as Cached[];
  } catch {
    return [];
  }
}
function writeCache(key: string, a: MatchupAnalysis) {
  try {
    const trimmed = {
      ...a,
      screening: { mine: a.screening.mine.slice(0, 12), theirs: a.screening.theirs.slice(0, 12) },
    };
    const xs = [{ key, a: trimmed }, ...readCache().filter((c) => c.key !== key)].slice(0, 12);
    localStorage.setItem(CACHE_KEY, JSON.stringify(xs));
  } catch {
    /* storage full or unavailable */
  }
}

const STAGE: Record<string, string> = {
  screening: "全選出の予備戦",
  matrix: "上位選出の総当たり",
  strong: "最善手同士の対戦（探索）",
  turn1: "1ターン目の択",
};

export function SimTab({
  teams,
  regulationId,
  mineId,
  setMineId,
  oppId,
  setOppId,
  onOpenBoard,
}: {
  teams: TeamEntry[];
  regulationId: string;
  mineId: string;
  setMineId: (id: string) => void;
  oppId: string;
  setOppId: (id: string) => void;
  onOpenBoard: (s: BoardStart) => void;
}) {
  const session = useSession();
  const mine = teams.find((t) => t.id === mineId);
  const opp = teams.find((t) => t.id === oppId);
  const [preset, setPreset] = useState<Preset>("normal");
  const [result, setResult] = useState<MatchupAnalysis | null>(null);
  const [pre, setPre] = useState<PrecomputedMatchup | null>(null);
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);

  const parsed = useMemo(() => {
    if (!session || !mine || !opp) return null;
    try {
      const a = session.parseTeam(mine.text, regulationId).members;
      const b = session.parseTeam(opp.text, regulationId).members;
      return { a, b, ha: session.teamHash(a), hb: session.teamHash(b) };
    } catch {
      return null;
    }
  }, [session, mine, opp, regulationId]);
  const ha = parsed?.ha ?? "";
  const hb = parsed?.hb ?? "";

  // precomputed (CLI) or cached (this device) results appear immediately
  useEffect(() => {
    setResult(null);
    setPre(null);
    setSource("");
    setError(null);
    if (!ha || !hb) return;
    const entry = findPrecomputed(ha, hb);
    if (entry) {
      loadPrecomputed(entry.file).then((p) => {
        if (!p) return;
        setPre(p);
        setResult(p.analysis);
        setSource(`事前計算（CLI・全コア）: ${p.analysis.battles}戦 ＋ 最善手同士の対戦1戦`);
      });
      return;
    }
    const c = readCache().find((x) => x.key.startsWith(`${ha}.${hb}.`));
    if (c) {
      setResult(c.a);
      setSource(`この端末で計算済み: ${c.a.battles}戦`);
    }
  }, [ha, hb]);

  const run = async () => {
    if (!parsed) return;
    const s = await loadSession();
    const n = s.bringCount(regulationId);
    if (parsed.a.length < n || parsed.b.length < n) {
      setError(`どちらのパーティも${n}匹以上必要です`);
      return;
    }
    const my = ++runId.current;
    const pool = poolFor(regulationId);
    pool.done = 0;
    let base = 0;
    let total = 0;
    pool.onWork = (d) => my === runId.current && setProgress({ done: d - base, total });
    setBusy("準備中");
    setError(null);
    const t0 = performance.now();
    try {
      const a = await s.runMatchup(
        regulationId,
        parsed.a,
        parsed.b,
        pool,
        preset,
        1,
        (stage, n2) => {
          base = pool.done;
          total = n2;
          setBusy(STAGE[stage] ?? stage);
          setProgress({ done: 0, total: n2 });
        },
      );
      if (my !== runId.current) return;
      setResult(a);
      setPre(null);
      setSource(
        `この端末で計算: ${a.battles}戦（${Math.round((performance.now() - t0) / 1000)}秒、${pool.size}並列）`,
      );
      writeCache(`${ha}.${hb}.${preset}`, a);
    } catch (e) {
      if (my === runId.current && (e as Error).message !== "cancelled")
        setError((e as Error).message);
    } finally {
      if (my === runId.current) {
        setBusy(null);
        setProgress(null);
      }
    }
  };
  const cancel = () => {
    runId.current++;
    poolFor(regulationId).cancel();
    setBusy(null);
    setProgress(null);
  };

  const rec = result && parsed ? session?.recommended(result, parsed.a, parsed.b) : undefined;
  const open = (ca: Config, cb: Config, seed: number, positions?: BoardStart["positions"]) => {
    if (!parsed || !mine || !opp) return;
    onOpenBoard({
      mine: parsed.a,
      theirs: parsed.b,
      mineName: mine.name,
      theirName: opp.name,
      ca,
      cb,
      seed,
      ...(positions ? { positions } : {}),
    });
  };

  const st = result?.strong;
  const mat = st ?? result?.matrix;
  const eq = st ? st.equilibrium : result?.equilibrium;
  const safest = st ? st.safest : result?.safest;
  const best = eq ? eq.mine.indexOf(Math.max(...eq.mine)) : -1;

  return (
    <div className="tab-body">
      <section className="card">
        <TeamPicker label="自分" teams={teams} value={mineId} onChange={setMineId} />
        <TeamPicker label="相手" teams={teams} value={oppId} onChange={setOppId} />
        {opp?.estimated && (
          <p className="estimated-note">〜 相手の技・特性・性格・SPは使用率から推定</p>
        )}
        <div className="seg" role="group" aria-label="計算量">
          {(["fast", "normal", "deep"] as const).map((p) => (
            <button
              key={p}
              className={preset === p ? "on" : ""}
              aria-pressed={preset === p}
              onClick={() => setPreset(p)}
            >
              {p === "fast" ? "速い" : p === "normal" ? "標準" : "精密"}
            </button>
          ))}
        </div>
        <div className="row">
          {busy ? (
            <button className="danger" onClick={cancel}>
              中止
            </button>
          ) : (
            <button className="primary" onClick={run} disabled={!parsed}>
              {result ? "この端末で計算し直す" : "選出をシミュレーション"}
            </button>
          )}
          {!session && <span className="muted small">シミュレーターを読み込み中…</span>}
        </div>
        {busy && (
          <div className="progress" aria-live="polite">
            <div>{busy}</div>
            {progress && progress.total > 0 && (
              <progress max={progress.total} value={Math.min(progress.done, progress.total)} />
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>

      {result && mat && eq && safest && (
        <>
          <section className="card" aria-labelledby="rec-h">
            <h2 id="rec-h">推奨選出</h2>
            <p className="muted small">{source}</p>
            <div className="big-rec">
              <BringNames species={mat.mine[best]!} />
              <div className="rec-num">
                期待勝率 <strong>{pct(eq.value)}</strong>
                <span className="muted small">（相手も最適に選出した場合）</span>
              </div>
            </div>
            <p className="small">
              安全策: <BringNames species={mat.mine[safest.index]!} />
              （最低 {pct(safest.worstRate)}）
            </p>
            <div className="row">
              {rec && (
                <button className="primary" onClick={() => open(rec.mine, rec.theirs, 1)}>
                  推奨選出で対戦盤を開く
                </button>
              )}
            </div>
            <p className="muted small">
              {st
                ? "上位の選出同士は、毎ターン両者が読み合いの最適な行動を探索して選ぶ対戦で評価しています。"
                : "選出の評価は行動方針（ヒューリスティック）同士の対戦です。"}
              数値はシミュレーションによる推定です。
            </p>
          </section>

          <section className="card" aria-labelledby="mat-h">
            <h2 id="mat-h">選出の読み合い</h2>
            <ol className="opp-cols">
              {mat.theirs.map((t, j) => (
                <li key={j}>
                  <span className="col-tag">{String.fromCharCode(65 + j)}</span>
                  <BringNames species={t} />
                  <span className="muted small"> 相手が選ぶ割合 {pct(eq.theirs[j]!)}</span>
                </li>
              ))}
            </ol>
            <div className="matrix">
              {mat.mine.map((m, i) => (
                <div key={i} className={`mrow ${i === best ? "best" : ""}`}>
                  <div className="mhead">
                    <BringNames species={m} />
                    <span className="muted small"> 推奨割合 {pct(eq.mine[i]!)}</span>
                  </div>
                  <div className="mcells">
                    {mat.cells[i]!.map((c, j) => (
                      <span key={j} className="mcell">
                        <span className="col-tag">{String.fromCharCode(65 + j)}</span>
                        <RateBar value={c.rate} />
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card" aria-labelledby="t1-h">
            <h2 id="t1-h">1ターン目の択</h2>
            <p className="small">
              <BringNames species={result.turnOne.mine} /> vs 相手{" "}
              <BringNames species={result.turnOne.theirs} />
            </p>
            <ol className="opp-cols">
              {result.turnOne.theirOptions.map((o, j) => (
                <li key={j}>
                  <span className="col-tag">{String.fromCharCode(97 + j)}</span>
                  {o.slots.map((x) => slotText(x)).join(" ／ ")}
                  <span className="muted small">
                    {" "}
                    相手が選ぶ割合 {pct(result.turnOne.equilibrium.theirs[j]!)}
                  </span>
                </li>
              ))}
            </ol>
            <ul className="opts">
              {result.turnOne.myOptions.map((o, i) => (
                <li key={i}>
                  <div>{o.slots.map((s) => slotText(s)).join(" ／ ")}</div>
                  <div className="muted small">
                    推奨割合 {pct(result.turnOne.equilibrium.mine[i]!)} ・ 相手の行動ごと:{" "}
                    {result.turnOne.cells[i]!.map(
                      (c, j) => `${String.fromCharCode(97 + j)} ${pct(c.rate)}`,
                    ).join(" / ")}
                  </div>
                </li>
              ))}
            </ul>
            <p className="small">
              {result.turnOne.dominant !== null
                ? "→ 相手の行動に関係なく最善の行動があります（択になりません）。"
                : result.turnOne.isGuess
                  ? "→ 択です。相手の行動で最善手が変わります。"
                  : "→ はっきりした択はありません。"}
            </p>
          </section>

          {pre && (
            <section className="card" aria-labelledby="best-h">
              <h2 id="best-h">最善手同士の対戦（事前計算）</h2>
              <p className="small">
                結果:{" "}
                <strong className={pre.best.result.winner === 0 ? "win" : "lose"}>
                  {pre.best.result.winner === 0
                    ? "勝ち"
                    : pre.best.result.winner === 1
                      ? "負け"
                      : "引き分け"}
                </strong>
                （{pre.best.result.turns}ターン、残り {pre.best.result.remaining[0]}対
                {pre.best.result.remaining[1]}）
              </p>
              <EvalSpark
                values={pre.best.turns.flatMap((t) => (t.eval !== undefined ? [t.eval] : []))}
              />
              <p className="muted small">
                毎ターン、両者の候補（上位{pre.search.keep}×{pre.search.keep}）を各
                {pre.search.matrixRollouts}〜{pre.search.matrixRollouts + pre.search.refineRollouts}
                戦させて読み合いの均衡を解いた結果です。対戦盤で同じ手を選ぶと、各局面の評価がすぐに表示されます。
              </p>
              <button
                onClick={() => open(pre.bring.mine, pre.bring.theirs, pre.seed, pre.positions)}
              >
                この対戦を対戦盤で開く
              </button>
            </section>
          )}
        </>
      )}
    </div>
  );
}
