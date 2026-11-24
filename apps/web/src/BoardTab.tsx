import { useEffect, useMemo, useRef, useState } from "react";
import type { PokemonSet } from "@ca/schema";
import type {
  BattleEvent,
  BattleView,
  Config,
  MonView,
  PositionAnalysis,
  SearchOption,
  Snapshot,
} from "@ca/sim";
import { poolFor, useSession } from "./engine/useEngine";
import type { DecisionReview, Preset } from "./engine/session";
import type { BoardStart } from "./SimTab";
import type { TeamEntry } from "./teams";
import { EvalSpark, RateBar } from "./ui/bits";
import {
  condLabel,
  eventText,
  it,
  mv,
  pct,
  slotText,
  sp,
  statLabel,
  statusLabel,
  weatherLabel,
} from "./ui/format";
import { TeamPicker } from "./ui/TeamPicker";

interface Node {
  state: Snapshot;
  view: BattleView;
  /** events of the step that led here */
  events: BattleEvent[];
  /** choices that led here (p1, p2) */
  choices?: [string, string];
  /** reflection on my decision that led here */
  review?: DecisionReview;
  /** the analysis that decision was made with */
  decidedWith?: PositionAnalysis;
}

type OppMode = "mix" | "search" | "manual";

const optLabel = (o: SearchOption) =>
  o.slots
    .filter((s) => s.species || s.switchTo)
    .map((s) => slotText(s))
    .join(" ／ ");

function bestOf(a: PositionAnalysis, s: 0 | 1): SearchOption | undefined {
  return a.options[s]
    .filter((o) => o.inMatrix)
    .sort((x, y) => y.prob - x.prob || y.value - x.value)[0];
}

function HpBar({ hp, maxhp }: { hp: number; maxhp: number }) {
  const r = maxhp ? hp / maxhp : 0;
  return (
    <span
      className={`hp ${r > 0.5 ? "hi" : r > 0.2 ? "md" : "lo"}`}
      aria-label={`HP ${Math.round(r * 100)}%`}
    >
      <span className="fill" style={{ width: `${Math.round(r * 100)}%` }} />
    </span>
  );
}

function MonCard({ m, mine }: { m: MonView | null; mine: boolean }) {
  if (!m) return <div className="mon empty">—</div>;
  return (
    <div className={`mon ${mine ? "me" : "op"}`}>
      <div className="mon-name">
        {sp(m.forme)}
        {m.status && <span className="st">{statusLabel(m.status)}</span>}
      </div>
      <HpBar hp={m.hp} maxhp={m.maxhp} />
      <div className="mon-sub">
        <span>
          {Math.round((m.hp / m.maxhp) * 100)}%{mine ? `（${m.hp}/${m.maxhp}）` : ""}
        </span>
        {m.item && <span className="muted">{it(m.item)}</span>}
      </div>
      {Object.keys(m.boosts).length > 0 && (
        <div className="boosts">
          {Object.entries(m.boosts).map(([k, v]) => (
            <span key={k} className={v > 0 ? "up" : "down"}>
              {statLabel(k)}
              {v > 0 ? `+${v}` : v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Bench({ ms, mine }: { ms: MonView[]; mine: boolean }) {
  return (
    <div className="bench" aria-label={mine ? "自分の控え" : "相手の控え"}>
      {ms.map((m) => (
        <span key={m.index} className={`bench-chip ${m.fainted ? "ko" : ""}`}>
          {sp(m.forme)} {m.fainted ? "×" : `${Math.round((m.hp / m.maxhp) * 100)}%`}
        </span>
      ))}
    </div>
  );
}

function FieldChips({ v }: { v: BattleView }) {
  const chips: string[] = [];
  if (v.weather) chips.push(weatherLabel(v.weather));
  if (v.terrain) chips.push(condLabel(v.terrain));
  for (const p of v.pseudoWeather) chips.push(condLabel(p));
  const side = (s: 0 | 1) =>
    v.sides[s].conditions.map((c) => `${s ? "相手" : "自分"}: ${condLabel(c)}`);
  return (
    <div className="field">
      {[...chips, ...side(1), ...side(0)].map((c, i) => (
        <span key={i} className="chip">
          {c}
        </span>
      ))}
      {chips.length + v.sides[0].conditions.length + v.sides[1].conditions.length === 0 && (
        <span className="muted small">場の効果なし</span>
      )}
    </div>
  );
}

/** Reflection on the decision that led to this position. */
function ReviewCard({
  r,
  an,
  after: afterRaw,
  cv,
}: {
  r: DecisionReview;
  an: PositionAnalysis;
  after: number | undefined;
  cv: (p: number) => number;
}) {
  const expected = cv(r.expected);
  const after = afterRaw === undefined ? undefined : cv(afterRaw);
  const label = (c: string | undefined, s: 0 | 1) => {
    const o = c ? an.options[s].find((x) => x.choice === c) : undefined;
    return o ? optLabel(o) : "—";
  };
  const opp = r.actualColumn >= 0 ? an.matrixChoices[1][r.actualColumn] : undefined;
  const good = (r.regret ?? 0) <= 0.005;
  return (
    <section className="card review" aria-labelledby="review-h">
      <h2 id="review-h">振り返り（直前の判断）</h2>
      <dl className="kv">
        <dt>決めたときの予想勝率</dt>
        <dd>{pct(expected)}</dd>
        {after !== undefined && (
          <>
            <dt>結果を見た後の評価</dt>
            <dd>
              {pct(after)}（{after >= expected ? "+" : ""}
              {Math.round((after - expected) * 100)}）
            </dd>
          </>
        )}
        <dt>相手の実際の行動</dt>
        <dd>
          {r.opponentActed
            ? opp
              ? `${label(opp, 1)}（予測していた確率 ${pct(r.predictedProb)}）`
              : "予測の候補になかった行動"
            : "相手は行動なし"}
        </dd>
      </dl>
      {r.bestVsActual !== undefined && (
        <p className={`small ${good ? "win" : ""}`}>
          {good
            ? `相手の実際の行動に対しても、選んだ手が最善でした（勝率 ${pct(r.vsActual ?? r.bestVsActual)}）。`
            : `相手の行動が分かっていれば「${label(r.bestChoice, 0)}」が最善でした（${pct(r.vsActual ?? 0)} → ${pct(r.bestVsActual)}、差 ${Math.round((r.regret ?? 0) * 100)}ポイント）。`}
        </p>
      )}
      <p className="muted small">
        予想と結果のずれは、相手の読み（予測の割合）と評価の精度の手がかりです。CLI の pnpm
        sim:review で多数の対戦をまとめて振り返り、pnpm sim:tune で重みを調整できます。
      </p>
    </section>
  );
}

/** Pick a bring by tapping members in order (1–2 lead, 3–4 back). */
function BringPicker({
  team,
  value,
  onChange,
  label,
}: {
  team: PokemonSet[];
  value: number[];
  onChange: (v: number[]) => void;
  label: string;
}) {
  return (
    <div className="bringpick" role="group" aria-label={label}>
      <div className="small">{label}（タップした順に 先発2・後ろ2）</div>
      <div className="chips">
        {team.map((m, i) => {
          const k = value.indexOf(i);
          return (
            <button
              key={i}
              className={`chip ${k >= 0 ? "on" : ""}`}
              aria-pressed={k >= 0}
              onClick={() =>
                onChange(
                  k >= 0 ? value.filter((x) => x !== i) : value.length < 4 ? [...value, i] : value,
                )
              }
            >
              {k >= 0 ? `${k < 2 ? "先" : "後"}${k + 1} ` : ""}
              {sp(m.species)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function BoardTab({
  teams,
  regulationId,
  mineId,
  setMineId,
  oppId,
  setOppId,
  start,
  setStart,
}: {
  teams: TeamEntry[];
  regulationId: string;
  mineId: string;
  setMineId: (id: string) => void;
  oppId: string;
  setOppId: (id: string) => void;
  start: BoardStart | null;
  setStart: (s: BoardStart | null) => void;
}) {
  const session = useSession();
  /** displayed win rate (calibrated by reviews when weights.json has a fit) */
  const cv = (p: number) => (session ? session.shown(regulationId, p) : p);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [cur, setCur] = useState(0);
  const [preset, setPreset] = useState<Preset>("normal");
  const [analyses, setAnalyses] = useState<Record<string, PositionAnalysis>>({});
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [myPick, setMyPick] = useState<string | null>(null);
  const [custom, setCustom] = useState<string[] | null>(null);
  const [customVal, setCustomVal] = useState<Record<string, number>>({});
  const [oppMode, setOppMode] = useState<OppMode>("mix");
  const [oppPick, setOppPick] = useState<string | null>(null);
  const [reroll, setReroll] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [bringA, setBringA] = useState<number[]>([0, 1, 2, 3]);
  const [bringB, setBringB] = useState<number[]>([0, 1, 2, 3]);
  const [seed, setSeed] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const runId = useRef(0);
  const pool = useMemo(() => poolFor(regulationId), [regulationId]);

  // (re)start from the given position
  useEffect(() => {
    if (!session || !start) return;
    try {
      const p = session.startPosition(
        regulationId,
        start.mine,
        start.theirs,
        start.ca,
        start.cb,
        start.seed,
      );
      setNodes([{ state: p.state, view: p.view, events: [] }]);
      setCur(0);
      setAnalyses({ ...(start.positions ?? {}) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [session, start, regulationId]);

  const node = nodes[cur];
  const view = node?.view;
  const an = view ? analyses[view.key] : undefined;
  const needs: [boolean, boolean] = view
    ? [
        view.request[0] === "move" || view.request[0] === "switch",
        view.request[1] === "move" || view.request[1] === "switch",
      ]
    : [false, false];

  // reset choices when the position changes
  useEffect(() => {
    setMyPick(null);
    setCustom(null);
    setOppPick(null);
    setShowAll(false);
  }, [view?.key]);

  const runAnalysis = async (force = false) => {
    if (!session || !node || !view || view.ended) return;
    if (!force && analyses[view.key]) return;
    const my = ++runId.current;
    setBusy(true);
    setProgress(0);
    pool.done = 0;
    pool.onWork = (d) => my === runId.current && setProgress(d);
    try {
      const a = await session.analyze(regulationId, node.state, pool, preset, view.key);
      if (my !== runId.current) return;
      setAnalyses((x) => ({ ...x, [view.key]: a }));
    } catch (e) {
      if (my === runId.current && (e as Error).message !== "cancelled")
        setError((e as Error).message);
    } finally {
      if (my === runId.current) setBusy(false);
    }
  };

  // analyse every new decision automatically (precomputed positions are used as they are)
  useEffect(() => {
    if (view && !view.ended && (needs[0] || needs[1]) && !analyses[view.key]) void runAnalysis();
  }, [view?.key, session]);

  const stop = () => {
    runId.current++;
    pool.cancel();
    setBusy(false);
  };

  const slots = useMemo(
    () => (session && node && needs[0] ? session.choicesFor(regulationId, node.state, 0) : null),
    [session, node?.view.key],
  );

  const myChoice = (): string => {
    if (!needs[0]) return "";
    if (custom) return slots?.kind === "switch" ? (custom[0] ?? "") : custom.join(", ");
    if (myPick) return myPick;
    return an ? (bestOf(an, 0)?.choice ?? "") : "";
  };
  /** The opponent's concrete choice. Intents are resolved in the real game only at this point. */
  const oppChoice = async (): Promise<string> => {
    if (!session || !node || !needs[1]) return "";
    let c = "";
    if (oppMode === "search") {
      // the opponent plans from its own point of view (my hidden information sampled)
      setBusy(true);
      try {
        const a1 = await session.analyze(regulationId, node.state, pool, preset, view!.key, 1);
        c = bestOf(a1, 1)?.choice ?? "";
      } finally {
        setBusy(false);
      }
    } else if (an) {
      if (oppMode === "manual" && oppPick) c = oppPick;
      else {
        const mix = an.options[1].filter((o) => o.inMatrix && o.prob > 0);
        c = session.drawFrom(mix, `${view!.key}:${cur}`);
      }
    }
    return c ? session.concreteChoice(regulationId, node.state, 1, c) : "";
  };

  const play = async () => {
    if (!session || !node) return;
    stop();
    try {
      const mine = myChoice();
      const theirs = await oppChoice();
      const r = session.stepPosition(
        regulationId,
        node.state,
        mine,
        theirs,
        reroll ? { reroll: (Date.now() & 0x7fffffff) | 1 } : {},
      );
      const review =
        an && needs[0]
          ? session.review(regulationId, node.state, an, r.choices[0], r.choices[1])
          : undefined;
      const next: Node = {
        state: r.state,
        view: r.view,
        events: r.events,
        choices: r.choices,
        ...(review ? { review } : {}),
        ...(an ? { decidedWith: an } : {}),
      };
      setNodes([...nodes.slice(0, cur + 1), next]);
      setCur(cur + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const evalCustom = async () => {
    if (!session || !node || !custom) return;
    const c = myChoice();
    const opp = an ? an.options[1].filter((o) => o.inMatrix && o.prob > 0) : [];
    setBusy(true);
    try {
      const v = await session.evaluateChoice(regulationId, node.state, pool, c, opp, 48);
      setCustomVal((x) => ({ ...x, [`${view!.key}|${c}`]: v }));
    } finally {
      setBusy(false);
    }
  };

  // ---------- setup (no game yet) ----------
  const mineTeam = teams.find((t) => t.id === mineId);
  const oppTeam = teams.find((t) => t.id === oppId);
  const parsed = useMemo(() => {
    if (!session || !mineTeam || !oppTeam) return null;
    return {
      a: session.parseTeam(mineTeam.text, regulationId).members,
      b: session.parseTeam(oppTeam.text, regulationId).members,
    };
  }, [session, mineTeam, oppTeam, regulationId]);

  const setup = (
    <section className="card" aria-labelledby="setup-h">
      <h2 id="setup-h">対戦を始める</h2>
      <TeamPicker
        label="自分のパーティ（対戦盤）"
        teams={teams}
        value={mineId}
        onChange={setMineId}
      />
      <TeamPicker
        label="相手のパーティ（対戦盤）"
        teams={teams}
        value={oppId}
        onChange={setOppId}
      />
      {parsed && (
        <>
          <BringPicker team={parsed.a} value={bringA} onChange={setBringA} label="自分の選出" />
          <BringPicker team={parsed.b} value={bringB} onChange={setBringB} label="相手の選出" />
        </>
      )}
      <label className="picker">
        <span>乱数シード</span>
        <input
          type="number"
          inputMode="numeric"
          value={seed}
          onChange={(e) => setSeed(Number(e.target.value) || 1)}
        />
      </label>
      <button
        className="primary"
        disabled={!parsed || bringA.length !== 4 || bringB.length !== 4}
        onClick={() =>
          parsed &&
          setStart({
            mine: parsed.a,
            theirs: parsed.b,
            mineName: mineTeam!.name,
            theirName: oppTeam!.name,
            ca: bringA as Config,
            cb: bringB as Config,
            seed,
          })
        }
      >
        この選出で開始
      </button>
      <p className="muted small">
        選出分析タブの「対戦盤を開く」からも、推奨選出のまま始められます。
      </p>
    </section>
  );

  if (!session)
    return (
      <div className="tab-body">
        <p className="muted">シミュレーターを読み込み中…</p>
      </div>
    );
  if (!start || !view || !node)
    return (
      <div className="tab-body">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {setup}
      </div>
    );

  const evals = nodes.slice(0, cur + 1).flatMap((n) => {
    const a = analyses[n.view.key];
    return a
      ? [a.value]
      : n.view.ended
        ? [n.view.winner === 0 ? 1 : n.view.winner === 1 ? 0 : 0.5]
        : [];
  });
  const myOpts = an?.options[0] ?? [];
  const oppOpts = an?.options[1] ?? [];
  const shown = showAll ? myOpts : myOpts.slice(0, 6);
  const chosenMine = myChoice();
  const chosenOpp = oppMode === "manual" ? oppPick : null;
  const cell =
    an && chosenOpp
      ? (() => {
          const i = an.matrixChoices[0].indexOf(chosenMine);
          const j = an.matrixChoices[1].indexOf(chosenOpp);
          return i >= 0 && j >= 0 ? an.matrix[i]![j]! : undefined;
        })()
      : undefined;
  const customKey = custom ? `${view.key}|${myChoice()}` : "";
  const customInAn = custom ? myOpts.find((o) => o.choice === myChoice()) : undefined;

  return (
    <div className="tab-body board">
      <section className="card evalcard" aria-label="評価値">
        <div className="eval-top">
          <div>
            <div className="muted small">
              {start.mineName} vs {start.theirName}
            </div>
            <div className="turn">
              {view.ended
                ? "対戦終了"
                : `${view.turn}ターン目${view.request.includes("switch") ? "（交代）" : ""}`}
            </div>
          </div>
          <div className="eval-num" aria-live="polite">
            {view.ended ? (
              <strong className={view.winner === 0 ? "win" : "lose"}>
                {view.winner === 0 ? "勝ち" : view.winner === 1 ? "負け" : "引き分け"}
              </strong>
            ) : an ? (
              <>
                <span className="muted small">勝率</span> <strong>{pct(cv(an.value))}</strong>
              </>
            ) : (
              <span className="muted small">{busy ? "評価中…" : "未評価"}</span>
            )}
          </div>
        </div>
        <EvalSpark values={evals} />
        <div className="timeline" role="group" aria-label="手順">
          {nodes.map((n, i) => (
            <button key={i} className={`chip ${i === cur ? "on" : ""}`} onClick={() => setCur(i)}>
              {i === 0
                ? "開始"
                : n.view.ended
                  ? "終"
                  : `${n.view.turn}${n.view.request.includes("switch") ? "交" : ""}`}
              {analyses[n.view.key] ? ` ${pct(cv(analyses[n.view.key]!.value))}` : ""}
            </button>
          ))}
        </div>
      </section>

      <section className="card fieldcard" aria-label="場">
        <div className="side-label">相手</div>
        <div className="actives">
          {view.sides[1].active.map((m, i) => (
            <MonCard key={i} m={m} mine={false} />
          ))}
        </div>
        <Bench ms={view.sides[1].bench} mine={false} />
        <FieldChips v={view} />
        <div className="actives">
          {view.sides[0].active.map((m, i) => (
            <MonCard key={i} m={m} mine />
          ))}
        </div>
        <Bench ms={view.sides[0].bench} mine />
        <div className="side-label">自分</div>
      </section>

      {node.events.length > 0 && (
        <details className="card" open>
          <summary>直前のターン</summary>
          <ul className="events">
            {node.events.map((e, i) => {
              const t = eventText(e);
              return t ? <li key={i}>{t}</li> : null;
            })}
          </ul>
        </details>
      )}

      {node.review && node.decidedWith && (
        <ReviewCard
          cv={cv}
          r={node.review}
          an={node.decidedWith}
          after={
            an?.value ??
            (view.ended ? (view.winner === 0 ? 1 : view.winner === 1 ? 0 : 0.5) : undefined)
          }
        />
      )}

      {!view.ended && (
        <section className="card" aria-labelledby="mine-h">
          <div className="row between">
            <h2 id="mine-h">
              {needs[0]
                ? view.request[0] === "switch"
                  ? "自分の交代先"
                  : "自分の行動"
                : "相手の交代を待っています"}
            </h2>
            <div className="seg small" role="group" aria-label="評価の計算量">
              {(["fast", "normal", "deep"] as const).map((p) => (
                <button
                  key={p}
                  className={preset === p ? "on" : ""}
                  aria-pressed={preset === p}
                  onClick={() => setPreset(p)}
                >
                  {p === "fast" ? "速" : p === "normal" ? "標" : "精"}
                </button>
              ))}
            </div>
          </div>
          {busy && (
            <div className="progress" aria-live="polite">
              両者の候補を対戦させて評価中…（{progress}戦）
              <button className="small" onClick={stop}>
                中止
              </button>
            </div>
          )}
          {!busy && an && (
            <p className="muted small">
              {an.rollouts}戦で評価（候補 自分{an.options[0].length}・相手{an.options[1].length}
              、上位
              {an.matrixChoices[0].length}×{an.matrixChoices[1].length}で読み合い）
              <button className="link" onClick={() => void runAnalysis(true)}>
                再評価
              </button>
            </p>
          )}
          {!busy && !an && (needs[0] || needs[1]) && (
            <button onClick={() => void runAnalysis(true)}>評価する</button>
          )}

          {needs[0] && (
            <>
              <div className="seg" role="tablist" aria-label="行動の選び方">
                <button className={custom === null ? "on" : ""} onClick={() => setCustom(null)}>
                  候補から選ぶ
                </button>
                <button
                  className={custom !== null ? "on" : ""}
                  onClick={() =>
                    slots &&
                    setCustom(
                      slots.kind === "switch"
                        ? [slots.switches[0] ?? ""]
                        : slots.slots.map((s) => s.options[0]?.choice ?? "pass"),
                    )
                  }
                >
                  自分で組む
                </button>
              </div>
              {custom === null ? (
                <ul className="opts selectable">
                  {shown.map((o) => {
                    const on = chosenMine === o.choice;
                    return (
                      <li key={o.choice}>
                        <button
                          className={`opt ${on ? "on" : ""}`}
                          aria-pressed={on}
                          onClick={() => setMyPick(o.choice)}
                        >
                          <span className="opt-text">{optLabel(o)}</span>
                          <RateBar value={cv(o.value)} />
                          <span className="opt-meta muted small">
                            {o.inMatrix ? (
                              <>
                                推奨 {pct(o.prob)} ・ 最悪 {pct(o.worst)} ・ {o.games}戦
                              </>
                            ) : (
                              <>絞り込みで除外（相手は方針どおり・{o.games}戦）</>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {myOpts.length > 6 && !showAll && (
                    <li>
                      <button className="link" onClick={() => setShowAll(true)}>
                        残り{myOpts.length - 6}件を表示
                      </button>
                    </li>
                  )}
                </ul>
              ) : (
                slots && (
                  <div className="custom">
                    {slots.kind === "switch" ? (
                      <label className="picker">
                        <span>交代先</span>
                        <select value={custom[0]} onChange={(e) => setCustom([e.target.value])}>
                          {slots.switches.map((c) => (
                            <option key={c} value={c}>
                              {c
                                .split(", ")
                                .map((p) => {
                                  const m = /^switch (\d+)/.exec(p);
                                  const mon = m
                                    ? [...view.sides[0].bench, ...view.sides[0].active].find(
                                        (x) => x?.index === Number(m[1]),
                                      )
                                    : null;
                                  return mon ? sp(mon.forme) : "—";
                                })
                                .join(" ＋ ")}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      slots.slots.map((s, si) => (
                        <label key={si} className="picker">
                          <span>{s.species ? sp(s.species) : `枠${si + 1}`}</span>
                          <select
                            value={custom[si]}
                            onChange={(e) =>
                              setCustom(custom.map((x, k) => (k === si ? e.target.value : x)))
                            }
                          >
                            {s.options.map((o) => (
                              <option key={o.choice} value={o.choice}>
                                {o.switchTo
                                  ? `${sp(o.switchTo)}に交代`
                                  : o.moveId
                                    ? `${o.choice.endsWith(" mega") ? "メガ＋" : ""}${mv(o.moveId)}${o.targetSpecies ? ` → ${sp(o.targetSpecies)}` : ""}`
                                    : o.choice}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))
                    )}
                    <div className="row">
                      {customInAn ? (
                        <span className="small">
                          この行動の勝率 <strong>{pct(customInAn.value)}</strong>（探索済み）
                        </span>
                      ) : customVal[customKey] !== undefined ? (
                        <span className="small">
                          この行動の勝率 <strong>{pct(customVal[customKey]!)}</strong>
                          （相手は均衡の混ぜ方、48戦）
                        </span>
                      ) : (
                        <button onClick={() => void evalCustom()} disabled={busy}>
                          この行動を評価（48戦）
                        </button>
                      )}
                    </div>
                  </div>
                )
              )}
            </>
          )}
        </section>
      )}

      {!view.ended && needs[1] && (
        <section className="card" aria-labelledby="opp-h">
          <h2 id="opp-h">相手の行動</h2>
          <div className="seg" role="group" aria-label="相手の動き方">
            {(
              [
                ["mix", "予測の割合で抽選"],
                ["search", "相手視点で探索"],
                ["manual", "指定"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                className={oppMode === k ? "on" : ""}
                aria-pressed={oppMode === k}
                onClick={() => setOppMode(k)}
              >
                {l}
              </button>
            ))}
          </div>
          {!an && (
            <p className="muted small">
              評価が終わるまでは、相手は行動方針（ヒューリスティック）で動きます。
            </p>
          )}
          <ul className={`opts ${oppMode === "manual" ? "selectable" : ""}`}>
            {oppOpts
              .filter((o) => o.inMatrix || oppMode === "manual")
              .slice(0, oppMode === "manual" ? 12 : 6)
              .map((o) => {
                const on = oppMode === "manual" && oppPick === o.choice;
                const body = (
                  <>
                    <span className="opt-text">{optLabel(o)}</span>
                    <span className="opt-meta small">
                      相手が選ぶ割合 <strong>{pct(o.prob)}</strong> ・ 相手から見た勝率{" "}
                      {pct(o.value)}
                    </span>
                  </>
                );
                return (
                  <li key={o.choice}>
                    {oppMode === "manual" ? (
                      <button
                        className={`opt ${on ? "on" : ""}`}
                        aria-pressed={on}
                        onClick={() => setOppPick(o.choice)}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="opt static">{body}</div>
                    )}
                  </li>
                );
              })}
          </ul>
          {cell !== undefined && (
            <p className="small">
              この組み合わせの勝率（自分）: <strong>{pct(cell)}</strong>
            </p>
          )}
        </section>
      )}

      {!view.ended && (
        <div className="actionbar">
          <button disabled={cur === 0} onClick={() => setCur(cur - 1)} aria-label="1手戻る">
            ↶ 戻る
          </button>
          <label className="reroll">
            <input type="checkbox" checked={reroll} onChange={(e) => setReroll(e.target.checked)} />
            乱数を変える
          </label>
          <button
            className="primary"
            onClick={() => void play()}
            disabled={busy || (needs[0] && !myChoice() && !!an)}
          >
            このターンを実行
          </button>
        </div>
      )}
      {view.ended && (
        <div className="actionbar">
          <button onClick={() => setCur(Math.max(0, cur - 1))}>↶ 戻る</button>
          <button onClick={() => setStart({ ...start })}>最初から</button>
        </div>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <details className="card">
        <summary>別の対戦を始める</summary>
        {setup}
      </details>
    </div>
  );
}
