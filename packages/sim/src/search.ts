// Per-position search for simultaneous moves (ADR-0011, ADR-0012).
//
// A doubles turn is a simultaneous-move game: both players pick a joint action without seeing the
// other's. At a position we
//   1) list candidate joint actions for each side (heuristic top-N plus every single-slot option),
//   2) prune each side's list by rollouts against the other side's policy,
//   3) fill a payoff matrix (kept × kept) with rollouts that share random seeds per column of
//      games (common random numbers: every cell's k-th game uses the same seed and world),
//   4) solve the matrix as a zero-sum game and spend extra rollouts on the equilibrium's support.
//
// Planner mode (`viewer`): the search may only use what that side can know. Rollouts start from
// possible worlds (belief.ts) in which the opponent's hidden information is sampled, and the
// opponent's options are intents ("its strongest attack on slot 1", "Protect") that each world
// resolves to its own moves. Full-information mode is kept for hindsight reviews and tests.
// Values are p1's win probability (draws = ½). Everything is deterministic for a given seed.
import { engineTags } from "@ca/data";
import { determinize, observe, type Prior } from "./belief.js";
import { solveZeroSum } from "./game.js";
import {
  forcedSwitchOptions,
  intentOf,
  jointIntentOf,
  resolveJointIntent,
  revealedMoves,
  searchCandidates,
  slotOptions,
  type JointOption,
} from "./policy.js";
import { restore, reseed, type Snapshot } from "./replay.js";
import { mixSeed, Rng } from "./rng.js";
import { playOut, type SimContext } from "./runner.js";
import type { PsBattle, PsSide } from "./showdown.js";

export interface RolloutItem {
  /** p1's choice for this decision ("" = let the policy choose, "i:…" = an intent) */
  a: string;
  /** p2's choice (same forms) */
  b: string;
  seed: number;
  /** index into the batch's worlds (default 0) */
  w?: number;
}

export interface RolloutBatch {
  /** the position (full information) — or use `worlds` */
  state?: Snapshot;
  /** possible worlds; items pick one with `w` */
  worlds?: Snapshot[];
  items: RolloutItem[];
}

/** Runs rollouts (in-process, worker threads or Web Workers). Results keep item order. */
export interface RolloutExecutor {
  rollouts(batch: RolloutBatch): Promise<number[]>;
}

/** Rollouts use the low (self) temperature on both sides so neither side's value is biased. */
export function rolloutContext(ctx: SimContext): SimContext {
  const T = ctx.params["selfTemperature"] ?? ctx.params["temperature"];
  return { ...ctx, params: { ...ctx.params, ...(T !== undefined ? { temperature: T } : {}) } };
}

/** Send one side's choice; intents are resolved in this world first. */
function send(ctx: SimContext, b: PsBattle, s: 0 | 1, choice: string): void {
  if (!choice) return;
  const id = s === 0 ? "p1" : "p2";
  const c = choice.startsWith("i:")
    ? resolveJointIntent(b, b.sides[s], choice.slice(2), engineTags(), ctx.params)
    : choice;
  if (!b.choose(id, c)) b.choose(id, "default");
}

/** One rollout: apply the given choices, then both sides follow the policy to the end. */
export function rollout(ctx: SimContext, state: Snapshot, item: RolloutItem): number {
  const b = restore(state);
  reseed(b, item.seed);
  send(ctx, b, 0, item.a);
  send(ctx, b, 1, item.b);
  const r = playOut(ctx, b, item.seed);
  return r.winner === 0 ? 1 : r.winner === 1 ? 0 : 0.5;
}

/** The world an item runs in. */
export const worldOf = (batch: RolloutBatch, item: RolloutItem): Snapshot =>
  batch.worlds ? batch.worlds[item.w ?? 0]! : batch.state!;

export function inProcessRollouts(ctx: SimContext): RolloutExecutor {
  const rc = rolloutContext(ctx);
  return {
    rollouts: (batch) =>
      Promise.resolve(batch.items.map((it) => rollout(rc, worldOf(batch, it), it))),
  };
}

export interface SearchBudget {
  /** heuristic joint candidates kept before pruning (plus each single-slot option's best completion) */
  width: number;
  /** rollouts per candidate in the pruning stage (vs the other side's policy) */
  pruneRollouts: number;
  /** candidates per side that enter the payoff matrix */
  keep: number;
  /** rollouts per matrix cell */
  matrixRollouts: number;
  /** extra rollouts per cell on the equilibrium's support */
  refineRollouts: number;
  /** a row/column is "in the support" when its equilibrium probability is at least this */
  refineSupport: number;
  /** fictitious-play iterations */
  iterations: number;
  /** possible worlds sampled per decision in planner (hidden-information) mode */
  worlds: number;
  /** extra opponent columns kept in planner mode (its options are uncertain, so cover more) */
  opponentExtra: number;
}

/** Read the search budget from weights.json `simulation` (search* keys). `scale` multiplies rollouts. */
export function searchBudgetFrom(params: Record<string, number>, scale = 1): SearchBudget {
  const req = (k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`weights.simulation.${k} is missing`);
    return v;
  };
  const r = (k: string) => Math.max(1, Math.round(req(k) * scale));
  return {
    width: req("searchWidth"),
    pruneRollouts: r("searchPruneRollouts"),
    keep: Math.max(
      2,
      Math.round(req("searchKeep") * Math.min(1.5, Math.max(0.6, Math.sqrt(scale)))),
    ),
    matrixRollouts: r("searchMatrixRollouts"),
    refineRollouts: Math.max(0, Math.round(req("searchRefineRollouts") * scale)),
    refineSupport: req("searchRefineSupport"),
    iterations: req("fictitiousIterations"),
    worlds: Math.max(1, Math.round(params["searchWorlds"] ?? 8)),
    opponentExtra: Math.max(0, Math.round(params["searchOpponentExtra"] ?? 0)),
  };
}

export interface OptionSlot {
  species: string;
  /** set for the opponent's options in planner mode: an intent (policy.ts), not a concrete move */
  intent?: string;
  moveId?: string;
  targetSpecies?: string;
  switchTo?: string;
  mega: boolean;
}

export interface SearchOption {
  choice: string;
  slots: OptionSlot[];
  /** this side's win rate if it plays this option and the other side plays its equilibrium mix */
  value: number;
  /** this side's win rate against the other side's reply that is worst for it (kept replies) */
  worst: number;
  /** equilibrium probability (0 for pruned options) */
  prob: number;
  /** rollouts that went into `value` */
  games: number;
  /** false = dropped in the pruning stage (value is vs the policy, not vs the equilibrium) */
  inMatrix: boolean;
  /** heuristic rank (0 = the policy's favourite) */
  rank: number;
}

/**
 * Identity of a position for caches: a hash of the full protocol log (both players' choices and
 * every random outcome so far are in it). Same teams + same history → same key.
 */
export function positionKey(b: PsBattle): string {
  let h = 0x811c9dc5;
  for (const line of b.log) {
    for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ 10, 0x01000193) >>> 0;
  }
  return `${b.log.length.toString(36)}-${h.toString(36)}`;
}

export interface PositionAnalysis {
  /** the side whose information was used: 0/1 = that side's view (hidden info sampled), null = full information */
  viewer: 0 | 1 | null;
  /** possible worlds the rollouts were spread over */
  worlds: number;
  /** positionKey of the analysed state */
  key: string;
  turn: number;
  /** which sides had a decision here */
  needs: [boolean, boolean];
  kind: "move" | "switch";
  /** per side, best first; values from that side's point of view */
  options: [SearchOption[], SearchOption[]];
  /** p1's win rate at the equilibrium (the position's evaluation) */
  value: number;
  /** payoff matrix (p1 win rate) over the in-matrix options, in `matrixChoices` order */
  matrix: number[][];
  matrixChoices: [string[], string[]];
  rollouts: number;
}

/** What a side has to decide now. */
function decisionOf(b: PsBattle, s: 0 | 1): "move" | "switch" | null {
  const side = b.sides[s];
  const r = side.activeRequest;
  if (!r || r.wait || side.isChoiceDone()) return null;
  if (r.forceSwitch) return "switch";
  return r.active ? "move" : null;
}

function labelSlots(side: PsSide, c: JointOption | string): OptionSlot[] {
  if (typeof c !== "string") {
    return c.slots.map((s, si) => {
      const m = side.active[si];
      return {
        species: m && !m.fainted ? m.species.id : "",
        ...(s.moveId ? { moveId: s.moveId } : {}),
        ...(s.targetSpecies ? { targetSpecies: s.targetSpecies } : {}),
        ...(s.switchTo ? { switchTo: s.switchTo } : {}),
        mega: s.choice.endsWith(" mega"),
      };
    });
  }
  return c.split(", ").map((part, si) => {
    const m = side.active[si];
    const sw = /^switch (\d+)/.exec(part);
    const to = sw ? side.pokemon[Number(sw[1]) - 1] : undefined;
    const seen =
      to && ((to as unknown as { previouslySwitchedIn?: number }).previouslySwitchedIn ?? 0) > 0;
    return {
      species: m ? m.species.id : "",
      ...(to && seen ? { switchTo: to.species.id } : to ? { intent: "W?" } : {}),
      mega: false,
    };
  });
}

/** Labels for an opponent's joint intent, from what the planner can see. */
function labelIntent(side: PsSide, joint: string): OptionSlot[] {
  return joint.split("|").map((it, si) => {
    const m = side.active[si];
    const foe = side.foe.active;
    const slot: OptionSlot = {
      species: m && !m.fainted ? m.species.id : "",
      intent: it,
      mega: false,
    };
    const tgt = (t: string | undefined) => {
      const f = t && t !== "-" ? foe[Number(t) - 1] : undefined;
      return f && !f.fainted ? { targetSpecies: f.species.id } : {};
    };
    if (it.startsWith("M:")) {
      const [, id, t] = it.split(":");
      return { ...slot, moveId: id!, ...tgt(t) };
    }
    if (/^[AF]\d$/.test(it)) return { ...slot, ...tgt(it.slice(1)) };
    if (it.startsWith("W")) {
      const to = side.pokemon[Number(it.slice(1)) - 1];
      const seen =
        to && ((to as unknown as { previouslySwitchedIn?: number }).previouslySwitchedIn ?? 0) > 0;
      return seen ? { ...slot, switchTo: to.species.id } : slot;
    }
    return slot;
  });
}

interface Cand {
  choice: string;
  slots: OptionSlot[];
  rank: number;
}

function concreteCandidates(ctx: SimContext, b: PsBattle, s: 0 | 1, width: number): Cand[] {
  const kind = decisionOf(b, s);
  const side = b.sides[s];
  if (kind === "switch")
    return forcedSwitchOptions(side, side.activeRequest!).map((choice, rank) => ({
      choice,
      slots: labelSlots(side, choice),
      rank,
    }));
  if (kind === "move")
    return searchCandidates(b, side, engineTags(), ctx.params, width).map((j, rank) => ({
      choice: j.choice,
      slots: labelSlots(side, j),
      rank,
    }));
  return [];
}

/**
 * The opponent's options as intents, gathered over several worlds (an intent that is good in
 * many worlds ranks first). Forced switches stay concrete: team positions are public.
 */
function intentCandidates(
  ctx: SimContext,
  real: PsBattle,
  worlds: PsBattle[],
  s: 0 | 1,
  width: number,
): Cand[] {
  const kind = decisionOf(real, s);
  if (kind === "switch") return concreteCandidates(ctx, real, s, width);
  if (kind !== "move") return [];
  const revealed = revealedMoves(real.sides[s]);
  const agg = new Map<string, { score: number; n: number }>();
  for (const w of worlds) {
    for (const j of searchCandidates(w, w.sides[s], engineTags(), ctx.params, width)) {
      const k = jointIntentOf(j, revealed);
      const a = agg.get(k) ?? { score: -Infinity, n: 0 };
      a.score = Math.max(a.score, j.score);
      a.n++;
      agg.set(k, a);
    }
  }
  return [...agg.entries()]
    .sort((x, y) => y[1].n - x[1].n || y[1].score - x[1].score || x[0].localeCompare(y[0]))
    .map(([k], rank) => ({ choice: `i:${k}`, slots: labelIntent(real.sides[s], k), rank }));
}

export interface AnalyzeOptions {
  /** plan from this side's point of view (hidden information sampled); omit for full information */
  viewer?: 0 | 1;
  /** prior over hidden sets (required for planner mode; without it the search uses full information) */
  prior?: Prior;
}

/**
 * Analyse one position (a Showdown state where at least one side must choose). Returns both
 * sides' options with their values, the equilibrium and the position's value.
 */
export async function analyzePosition(
  ctx: SimContext,
  state: Snapshot,
  exec: RolloutExecutor,
  budget: SearchBudget,
  seed: number,
  opts: AnalyzeOptions = {},
): Promise<PositionAnalysis> {
  const real = restore(state);
  const needs: [boolean, boolean] = [decisionOf(real, 0) !== null, decisionOf(real, 1) !== null];
  const kind = decisionOf(real, 0) === "move" || decisionOf(real, 1) === "move" ? "move" : "switch";
  const viewer = opts.viewer !== undefined && opts.prior ? opts.viewer : null;

  // possible worlds (planner mode) or the real state
  let worlds: Snapshot[] = [state];
  if (viewer !== null) {
    const obs = observe(real, viewer);
    const rng = new Rng(mixSeed(seed, 0x77));
    worlds = Array.from({ length: budget.worlds }, () =>
      determinize(ctx, state, real, obs, opts.prior!, rng),
    );
  }
  const W = worlds.length;
  const worldBattles = viewer !== null ? worlds.map(restore) : [real];
  const cands: [Cand[], Cand[]] = [[], []];
  for (const s of [0, 1] as const) {
    if (!needs[s]) continue;
    if (viewer === null) cands[s] = concreteCandidates(ctx, real, s, budget.width);
    // the planner's own options are ranked in a sampled world (its own side is the same in all)
    else if (s === viewer) cands[s] = concreteCandidates(ctx, worldBattles[0]!, s, budget.width);
    else cands[s] = intentCandidates(ctx, real, worldBattles, s, budget.width);
  }
  let rollouts = 0;
  const run = async (items: RolloutItem[]) => {
    rollouts += items.length;
    return items.length
      ? exec.rollouts(W === 1 ? { state: worlds[0]!, items } : { worlds, items })
      : [];
  };

  // 2) pruning: each candidate vs the other side's policy (shared seeds and worlds per k)
  const pruneVal: [number[], number[]] = [[], []];
  const kept: [number[], number[]] = [[], []];
  for (const s of [0, 1] as const) {
    const cs = cands[s];
    const keep = budget.keep + (viewer !== null && s !== viewer ? budget.opponentExtra : 0);
    if (cs.length <= keep) {
      kept[s] = cs.map((_, i) => i);
      continue;
    }
    const items: RolloutItem[] = [];
    cs.forEach((c) => {
      for (let k = 0; k < budget.pruneRollouts; k++)
        items.push({
          a: s === 0 ? c.choice : "",
          b: s === 1 ? c.choice : "",
          seed: mixSeed(seed, 0x9e, s, k),
          w: k % W,
        });
    });
    const res = await run(items);
    const n = budget.pruneRollouts;
    pruneVal[s] = cs.map((_, i) => {
      let v = 0;
      for (let k = 0; k < n; k++) v += res[i * n + k]!;
      v /= n;
      return s === 0 ? v : 1 - v;
    });
    const order = cs.map((_, i) => i).sort((x, y) => pruneVal[s][y]! - pruneVal[s][x]! || x - y);
    const top = new Set(order.slice(0, keep));
    if (!top.has(0)) {
      top.delete(order[keep - 1]!);
      top.add(0);
    }
    kept[s] = [...top].sort((x, y) => x - y);
  }

  // 3) payoff matrix with common random numbers (same seed and world for the k-th game)
  const rows = needs[0] ? kept[0] : [-1];
  const cols = needs[1] ? kept[1] : [-1];
  const sum = rows.map(() => cols.map(() => 0));
  const cnt = rows.map(() => cols.map(() => 0));
  const fill = async (ri: number[], ci: number[], from: number, n: number) => {
    const items: RolloutItem[] = [];
    const where: [number, number][] = [];
    for (const i of ri)
      for (const j of ci)
        for (let k = from; k < from + n; k++) {
          items.push({
            a: rows[i]! >= 0 ? cands[0][rows[i]!]!.choice : "",
            b: cols[j]! >= 0 ? cands[1][cols[j]!]!.choice : "",
            seed: mixSeed(seed, 0x3a, k),
            w: k % W,
          });
          where.push([i, j]);
        }
    const res = await run(items);
    res.forEach((v, x) => {
      const [i, j] = where[x]!;
      sum[i]![j]! += v;
      cnt[i]![j]!++;
    });
  };
  const all = (xs: unknown[]) => xs.map((_, i) => i);
  await fill(all(rows), all(cols), 0, budget.matrixRollouts);
  // shrink toward ½ by one pseudo-game so a cell with few games is not extreme
  const payoff = () => sum.map((r, i) => r.map((v, j) => (v + 0.5) / (cnt[i]![j]! + 1)));
  let eq = solveZeroSum(payoff(), budget.iterations);

  // 4) refine the support
  if (budget.refineRollouts > 0 && (rows.length > 1 || cols.length > 1)) {
    const support = (p: number[], vals: number[]) => {
      const top2 = all(vals)
        .sort((x, y) => vals[y]! - vals[x]!)
        .slice(0, 2);
      return all(p).filter((i) => p[i]! >= budget.refineSupport || top2.includes(i));
    };
    const m = payoff();
    const rowVals = m.map((r) => r.reduce((a, v, j) => a + v * eq.col[j]!, 0));
    const colVals = cols.map((_, j) => 1 - m.reduce((a, r, i) => a + r[j]! * eq.row[i]!, 0));
    await fill(
      support(eq.row, rowVals),
      support(eq.col, colVals),
      budget.matrixRollouts,
      budget.refineRollouts,
    );
    eq = solveZeroSum(payoff(), budget.iterations);
  }

  const m = payoff();
  const options: [SearchOption[], SearchOption[]] = [[], []];
  for (const s of [0, 1] as const) {
    if (!needs[s]) continue;
    const idx = s === 0 ? rows : cols;
    const inM = new Map(idx.map((ci, x) => [ci, x]));
    options[s] = cands[s]
      .map((c, ci): SearchOption => {
        const x = inM.get(ci);
        if (x === undefined)
          return {
            choice: c.choice,
            slots: c.slots,
            value: pruneVal[s][ci] ?? 0,
            worst: pruneVal[s][ci] ?? 0,
            prob: 0,
            games: budget.pruneRollouts,
            inMatrix: false,
            rank: c.rank,
          };
        const line = s === 0 ? m[x]! : m.map((r) => 1 - r[x]!);
        const other = s === 0 ? eq.col : eq.row;
        const games =
          s === 0 ? cnt[x]!.reduce((a, v) => a + v, 0) : cnt.reduce((a, r) => a + r[x]!, 0);
        return {
          choice: c.choice,
          slots: c.slots,
          value: line.reduce((a, v, j) => a + v * other[j]!, 0),
          worst: Math.min(...line),
          prob: (s === 0 ? eq.row : eq.col)[x]!,
          games,
          inMatrix: true,
          rank: c.rank,
        };
      })
      .sort(
        (x, y) =>
          Number(y.inMatrix) - Number(x.inMatrix) ||
          y.prob - x.prob ||
          y.value - x.value ||
          x.rank - y.rank,
      );
  }
  return {
    viewer,
    worlds: W,
    key: positionKey(real),
    turn: real.turn,
    needs,
    kind,
    options,
    value: eq.value,
    matrix: m,
    matrixChoices: [
      rows.map((i) => (i >= 0 ? cands[0][i]!.choice : "")),
      cols.map((j) => (j >= 0 ? cands[1][j]!.choice : "")),
    ],
    rollouts,
  };
}

/** The option to play from an analysis: the equilibrium's most likely action (deterministic). */
export function bestChoice(a: PositionAnalysis, s: 0 | 1): string {
  const opts = a.options[s].filter((o) => o.inMatrix);
  if (opts.length === 0) return "";
  let best = opts[0]!;
  for (const o of opts)
    if (o.prob > best.prob + 1e-9 || (Math.abs(o.prob - best.prob) <= 1e-9 && o.value > best.value))
      best = o;
  return best.choice;
}

/**
 * The column of an analysis that a concrete action of side `s` corresponds to (its intent in the
 * planner's terms, or the choice itself). -1 when the action was not among the candidates.
 */
export function columnOf(
  ctx: SimContext,
  a: PositionAnalysis,
  b: PsBattle,
  s: 0 | 1,
  choice: string,
): number {
  const list = a.matrixChoices[s];
  const direct = list.indexOf(choice);
  if (direct >= 0) return direct;
  if (!list.some((c) => c.startsWith("i:"))) return -1;
  const side = b.sides[s];
  const req = side.activeRequest;
  if (!req?.active) return -1;
  const revealed = revealedMoves(side);
  const parts = choice.split(", ").map((x) => x.replace(/ mega$/, ""));
  const opts = req.active.map((_, slot) =>
    slotOptions(b, side, slot, req, engineTags(), ctx.params),
  );
  const intent = parts
    .map((p, slot) => {
      const o = opts[slot]?.find((x) => x.choice.replace(/ mega$/, "") === p);
      return o ? intentOf(o, revealed) : p === "pass" ? "X" : "?";
    })
    .join("|");
  return list.indexOf(`i:${intent}`);
}

/** Concrete choice for side `s` in battle `b` (intents resolved). */
export function concreteFor(ctx: SimContext, b: PsBattle, s: 0 | 1, choice: string): string {
  return choice.startsWith("i:")
    ? resolveJointIntent(b, b.sides[s], choice.slice(2), engineTags(), ctx.params)
    : choice;
}
