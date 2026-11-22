// Main-thread engine API for the simulation tabs (lazy-loaded: pulls in Showdown).
// Orchestration (candidate lists, matrices) runs here; rollouts and battles run in SimPool.
import type { PokemonSet } from "@ca/schema";
import { canonicalJson, sha256Hex } from "@ca/data";
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
  mixSeed,
  type Config,
  type MatchupAnalysis,
  type PositionAnalysis,
  type Snapshot,
  type StepResult,
  type BattleView,
} from "@ca/sim";
import { contextFor } from "./context";
import type { SimPool } from "./pool";

export type { BattleView, PositionAnalysis, StepResult, Snapshot, MatchupAnalysis, Config };

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

export function analyze(
  regulationId: string,
  state: Snapshot,
  pool: SimPool,
  preset: Preset,
  key: string,
): Promise<PositionAnalysis> {
  const ctx = contextFor(regulationId);
  const budget = searchBudgetFrom(ctx.params, PRESETS[preset].search);
  let h = 7;
  for (let i = 0; i < key.length; i++) h = mixSeed(h, key.charCodeAt(i));
  return analyzePosition(ctx, state, pool.rolloutExecutor(), budget, h);
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
  const res = await pool.rolloutExecutor().rollouts({ state, items });
  const v = res.reduce((x, y) => x + y, 0) / n;
  return side === 0 ? v : 1 - v;
}
