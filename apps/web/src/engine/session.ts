// Main-thread engine API for the simulation tabs (lazy-loaded: pulls in Showdown).
// Orchestration (candidate lists, matrices) runs here; rollouts and battles run in SimPool.
import type { PokemonSet } from "@ca/schema";
import { canonicalJson, engineTags, sha256Hex } from "@ca/data";
import { parseShowdown } from "@ca/ingest";
import {
  analyzeMatchup,
  analyzePosition,
  budgetFrom,
  restore,
  searchBudgetFrom,
  slotChoices,
  snap,
  startBattle,
  step,
  battleView,
  resolveJointIntent,
  observe,
  determinize,
  Rng,
  reviewDecision,
  calibrated,
  type DecisionReview,
  mixSeed,
  type Config,
  type MatchupAnalysis,
  type PositionAnalysis,
  type Snapshot,
  type StepResult,
  type BattleView,
} from "@ca/sim";
import { contextFor, priorFor } from "./context";
import type { SimPool } from "./pool";

export type {
  BattleView,
  PositionAnalysis,
  StepResult,
  Snapshot,
  MatchupAnalysis,
  Config,
  DecisionReview,
};

export const teamHash = (sets: readonly PokemonSet[]) =>
  sha256Hex(canonicalJson(sets)).slice(0, 16);

export function parseTeam(text: string, regulationId: string) {
  const pack = contextFor(regulationId).pack;
  return parseShowdown(text, { legal: { species: pack.legal.species, items: pack.legal.items } });
}

export function bringCount(regulationId: string): number {
  return contextFor(regulationId).pack.rules.bringCount;
}

export function startPosition(
  regulationId: string,
  mine: PokemonSet[],
  theirs: PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
): { state: Snapshot; view: BattleView } {
  const b = startBattle(contextFor(regulationId), mine, theirs, ca, cb, seed);
  return { state: snap(b), view: battleView(b) };
}

export const viewOf = (state: Snapshot) => battleView(restore(state));

/** Rollout budget presets (multipliers of weights.json `simulation`). */
export const PRESETS = {
  fast: { label: "速い", search: 0.35, matchup: 0.12 },
  normal: { label: "標準", search: 0.7, matchup: 0.3 },
  deep: { label: "精密", search: 1.5, matchup: 0.8 },
} as const;
export type Preset = keyof typeof PRESETS;

/**
 * Analyse a position from `viewer`'s point of view: the opponent's unrevealed moves, items,
 * abilities, spreads and back line are sampled from usage statistics (never read from the game).
 */
export async function analyze(
  regulationId: string,
  state: Snapshot,
  pool: SimPool,
  preset: Preset,
  key: string,
  viewer: 0 | 1 = 0,
): Promise<PositionAnalysis> {
  const ctx = contextFor(regulationId);
  const budget = searchBudgetFrom(ctx.params, PRESETS[preset].search);
  let h = 7 + viewer;
  for (let i = 0; i < key.length; i++) h = mixSeed(h, key.charCodeAt(i));
  const prior = await priorFor(regulationId);
  return analyzePosition(ctx, state, pool.rolloutExecutor(), budget, h, {
    viewer,
    ...(prior ? { prior } : {}),
  });
}

/** Turn a side's option from an analysis ("i:A1|P" intents included) into a concrete choice. */
export function concreteChoice(
  regulationId: string,
  state: Snapshot,
  side: 0 | 1,
  choice: string,
): string {
  if (!choice.startsWith("i:")) return choice;
  const ctx = contextFor(regulationId);
  const b = restore(state);
  return resolveJointIntent(b, b.sides[side], choice.slice(2), engineTags(), ctx.params);
}

/** Reflection on my decision once both sides' actual choices are known. */
export function review(
  regulationId: string,
  state: Snapshot,
  an: PositionAnalysis,
  mine: string,
  theirs: string,
): DecisionReview {
  return reviewDecision(contextFor(regulationId), state, an, 0, mine, theirs);
}

export function stepPosition(
  regulationId: string,
  state: Snapshot,
  a: string,
  b: string,
  opts: { reroll?: number } = {},
): StepResult {
  return step(contextFor(regulationId), state, a, b, opts);
}

export function choicesFor(regulationId: string, state: Snapshot, side: 0 | 1) {
  return slotChoices(contextFor(regulationId), state, side);
}

export async function runMatchup(
  regulationId: string,
  mine: PokemonSet[],
  theirs: PokemonSet[],
  pool: SimPool,
  preset: Preset,
  seed: number,
  onStage: (stage: string, total: number) => void,
): Promise<MatchupAnalysis> {
  const ctx = contextFor(regulationId);
  const budget = budgetFrom(ctx.params, PRESETS[preset].matchup);
  if (preset === "fast") budget.strongConfigs = Math.min(budget.strongConfigs, 2);
  return analyzeMatchup(ctx, mine, theirs, pool.executor(mine, theirs), budget, seed, (s, _d, n) =>
    onStage(s, n),
  );
}

/** Recommended bring from an analysis (strong stage if present). */
export function recommended(
  a: MatchupAnalysis,
  mine: readonly PokemonSet[],
  theirs: readonly PokemonSet[],
): { mine: Config; theirs: Config } {
  const src = a.strong ?? a.matrix;
  const eq = a.strong ? a.strong.equilibrium : a.equilibrium;
  const top = (w: number[]) => w.indexOf(Math.max(...w));
  const cfg = (team: readonly PokemonSet[], sp: string[]) =>
    sp.map((x) => team.findIndex((m) => m.species === x)) as Config;
  return {
    mine: cfg(mine, src.mine[top(eq.mine)]!),
    theirs: cfg(theirs, src.theirs[top(eq.theirs)]!),
  };
}

/** Deterministic draw from a mixed strategy (for the opponent's "sample from equilibrium" mode). */
export function drawFrom(opts: { choice: string; prob: number }[], seedKey: string): string {
  let h = 11;
  for (let i = 0; i < seedKey.length; i++) h = mixSeed(h, seedKey.charCodeAt(i));
  let r = h / 4294967296;
  for (const o of opts) {
    r -= o.prob;
    if (r <= 0) return o.choice;
  }
  return opts.at(-1)?.choice ?? "";
}

/**
 * Win rate of one of my actions that the search did not evaluate (built by hand): `n` rollouts
 * where the opponent plays its equilibrium mix (stratified draws) or, without one, its policy.
 */
export async function evaluateChoice(
  regulationId: string,
  state: Snapshot,
  pool: SimPool,
  choice: string,
  opp: { choice: string; prob: number }[],
  n: number,
  side: 0 | 1 = 0,
): Promise<number> {
  const items = Array.from({ length: n }, (_, k) => {
    let r = (k + 0.5) / n;
    let b = "";
    for (const o of opp) {
      r -= o.prob;
      if (r <= 0) {
        b = o.choice;
        break;
      }
    }
    if (!b && opp.length) b = opp.at(-1)!.choice;
    const seed = mixSeed(0x3a, k);
    return side === 0 ? { a: choice, b, seed } : { a: b, b: choice, seed };
  });
  // possible worlds from my point of view: the opponent's hidden information is sampled
  const ctx = contextFor(regulationId);
  const prior = await priorFor(regulationId);
  let worlds = [state];
  if (prior) {
    const b = restore(state);
    const obs = observe(b, side);
    const rng = new Rng(mixSeed(0x5eed, n));
    worlds = Array.from({ length: Math.max(1, searchBudgetFrom(ctx.params).worlds) }, () =>
      determinize(ctx, state, b, obs, prior, rng),
    );
  }
  const res = await pool
    .rolloutExecutor()
    .rollouts({ worlds, items: items.map((it, k) => ({ ...it, w: k % worlds.length })) });
  const v = res.reduce((x, y) => x + y, 0) / n;
  return side === 0 ? v : 1 - v;
}

/** Win rate as displayed: corrected by the calibration learned from reviews (sim:review --fit). */
export function shown(regulationId: string, p: number): number {
  return calibrated(p, contextFor(regulationId).params);
}
