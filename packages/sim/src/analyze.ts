import type { PokemonSet } from "@ca/schema";
import { maximin, solveZeroSum, wilson } from "./game.js";
import type { JointOption } from "./policy.js";
import { mixSeed } from "./rng.js";
import {
  allConfigs,
  simulate,
  simulateForced,
  turnOneOptions,
  type BattleResult,
  type Config,
  type SimContext,
} from "./runner.js";

/** One battle to run. Deterministic given its fields. */
export interface BattleJob {
  a: Config;
  b: Config;
  seed: number;
  forced?: [string, string];
}

/** Runs jobs (in-process or in worker threads); results are returned in job order. */
export interface Executor {
  run(jobs: BattleJob[]): Promise<BattleResult[]>;
}

export function inProcessExecutor(
  ctx: SimContext,
  mine: readonly PokemonSet[],
  theirs: readonly PokemonSet[],
): Executor {
  return {
    run: (jobs) =>
      Promise.resolve(
        jobs.map((j) =>
          j.forced
            ? simulateForced(ctx, mine, theirs, j.a, j.b, j.forced[0], j.forced[1], j.seed)
            : simulate(ctx, mine, theirs, j.a, j.b, j.seed),
        ),
      ),
  };
}

export interface Budget {
  screenBattles: number;
  topConfigs: number;
  matrixBattles: number;
  turnOptions: number;
  turnRollouts: number;
  fictitiousIterations: number;
}

export function budgetFrom(params: Record<string, number>, scale = 1): Budget {
  const get = (k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`weights.simulation.${k} is missing`);
    return v;
  };
  const s = (k: string) => Math.max(1, Math.round(get(k) * scale));
  return {
    screenBattles: s("screenBattles"),
    topConfigs: Math.max(2, Math.round(get("topConfigs"))),
    matrixBattles: s("matrixBattles"),
    turnOptions: Math.max(2, Math.round(get("turnOptions"))),
    turnRollouts: s("turnRollouts"),
    fictitiousIterations: get("fictitiousIterations"),
  };
}

export interface Rate {
  wins: number;
  games: number;
  rate: number;
  ci: [number, number];
}
const rateOf = (rs: BattleResult[], side: 0 | 1): Rate => {
  // draws count as half
  const wins = rs.reduce((a, r) => a + (r.winner === side ? 1 : r.winner === null ? 0.5 : 0), 0);
  return {
    wins,
    games: rs.length,
    rate: rs.length ? wins / rs.length : 0,
    ci: wilson(wins, rs.length),
  };
};

export interface ConfigStat extends Rate {
  config: Config;
  /** species IDs: [lead1, lead2, back1, back2] */
  species: string[];
}

export interface OptionLabel {
  choice: string;
  slots: { species: string; moveId?: string; targetSpecies?: string; mega: boolean }[];
}

export interface TurnOneAnalysis {
  mine: ConfigStat["species"];
  theirs: ConfigStat["species"];
  myOptions: OptionLabel[];
  theirOptions: OptionLabel[];
  /** my win rate for [my option][their option] */
  cells: Rate[][];
  equilibrium: { mine: number[]; theirs: number[]; value: number };
  /** For each opponent option, my best reply. */
  bestReplies: { their: number; mine: number; rate: number }[];
  /** A dominant option of mine (best against every opponent option), if any. */
  dominant: number | null;
  /** True if the best reply depends on what the opponent does (a guessing game). */
  isGuess: boolean;
}

export interface MatchupAnalysis {
  budget: Budget;
  battles: number;
  screening: { mine: ConfigStat[]; theirs: ConfigStat[] };
  matrix: { mine: ConfigStat["species"][]; theirs: ConfigStat["species"][]; cells: Rate[][] };
  equilibrium: { mine: number[]; theirs: number[]; value: number };
  safest: { index: number; worstRate: number };
  turnOne: TurnOneAnalysis;
}

const speciesOf = (team: readonly PokemonSet[], c: Config) => c.map((i) => team[i]!.species);

function label(team: readonly PokemonSet[], c: Config, o: JointOption): OptionLabel {
  return {
    choice: o.choice,
    slots: o.slots.map((s, i) => ({
      species: team[c[i]!]!.species,
      ...(s.moveId ? { moveId: s.moveId } : {}),
      ...(s.targetSpecies ? { targetSpecies: s.targetSpecies } : {}),
      mega: s.choice.endsWith(" mega"),
    })),
  };
}

/**
 * Monte Carlo matchup analysis between my team and one opponent team:
 * 1) screen every bring/lead for both sides, 2) top-K × top-K payoff matrix solved as a
 * zero-sum game, 3) turn-1 decision matrix for the most likely pairing ("択").
 * Deterministic for a given seed and budget.
 */
export async function analyzeMatchup(
  ctx: SimContext,
  mine: readonly PokemonSet[],
  theirs: readonly PokemonSet[],
  exec: Executor,
  budget: Budget,
  seed: number,
  onProgress?: (stage: string, done: number, total: number) => void,
): Promise<MatchupAnalysis> {
  const bring = ctx.pack.rules.bringCount;
  const myConfigs = allConfigs(mine.length, Math.min(bring, mine.length));
  const theirConfigs = allConfigs(theirs.length, Math.min(bring, theirs.length));
  let battles = 0;

  // 1) screening
  const screenJobs: BattleJob[] = [];
  myConfigs.forEach((c, i) => {
    for (let k = 0; k < budget.screenBattles; k++)
      screenJobs.push({
        a: c,
        b: theirConfigs[(i * 7 + k * 13) % theirConfigs.length]!,
        seed: mixSeed(seed, 1, i, k),
      });
  });
  theirConfigs.forEach((c, i) => {
    for (let k = 0; k < budget.screenBattles; k++)
      screenJobs.push({
        a: myConfigs[(i * 11 + k * 17) % myConfigs.length]!,
        b: c,
        seed: mixSeed(seed, 2, i, k),
      });
  });
  onProgress?.("screening", 0, screenJobs.length);
  const screenRes = await exec.run(screenJobs);
  battles += screenRes.length;
  const n = budget.screenBattles;
  const stat = (
    team: readonly PokemonSet[],
    c: Config,
    rs: BattleResult[],
    side: 0 | 1,
  ): ConfigStat => ({ config: c, species: speciesOf(team, c), ...rateOf(rs, side) });
  const sortStats = (xs: ConfigStat[]) =>
    xs.sort((a, b) => b.rate - a.rate || a.config.join().localeCompare(b.config.join()));
  const myScreen = sortStats(
    myConfigs.map((c, i) => stat(mine, c, screenRes.slice(i * n, (i + 1) * n), 0)),
  );
  const off = myConfigs.length * n;
  const theirScreen = sortStats(
    theirConfigs.map((c, i) => stat(theirs, c, screenRes.slice(off + i * n, off + (i + 1) * n), 1)),
  );

  // 2) top-K matrix
  const K = budget.topConfigs;
  const myTop = myScreen.slice(0, K);
  const theirTop = theirScreen.slice(0, K);
  const matrixJobs: BattleJob[] = [];
  myTop.forEach((a, i) =>
    theirTop.forEach((b, j) => {
      for (let k = 0; k < budget.matrixBattles; k++)
        matrixJobs.push({ a: a.config, b: b.config, seed: mixSeed(seed, 3, i, j, k) });
    }),
  );
  onProgress?.("matrix", 0, matrixJobs.length);
  const matrixRes = await exec.run(matrixJobs);
  battles += matrixRes.length;
  const m = budget.matrixBattles;
  const cells = myTop.map((_, i) =>
    theirTop.map((_, j) =>
      rateOf(matrixRes.slice((i * theirTop.length + j) * m, (i * theirTop.length + j + 1) * m), 0),
    ),
  );
  const payoff = cells.map((r) => r.map((c) => c.rate));
  const eq = solveZeroSum(payoff, budget.fictitiousIterations);
  const safe = maximin(payoff);

  // 3) turn-1 options for the most likely pairing
  const mi = eq.row.indexOf(Math.max(...eq.row));
  const ti = eq.col.indexOf(Math.max(...eq.col));
  const ca = myTop[mi]!.config;
  const cb = theirTop[ti]!.config;
  const [myOpts, theirOpts] = turnOneOptions(ctx, mine, theirs, ca, cb, budget.turnOptions);
  const turnJobs: BattleJob[] = [];
  myOpts.forEach((a, i) =>
    theirOpts.forEach((b, j) => {
      for (let k = 0; k < budget.turnRollouts; k++)
        turnJobs.push({
          a: ca,
          b: cb,
          forced: [a.choice, b.choice],
          seed: mixSeed(seed, 4, i, j, k),
        });
    }),
  );
  onProgress?.("turn1", 0, turnJobs.length);
  const turnRes = await exec.run(turnJobs);
  battles += turnRes.length;
  const r = budget.turnRollouts;
  const tCells = myOpts.map((_, i) =>
    theirOpts.map((_, j) =>
      rateOf(turnRes.slice((i * theirOpts.length + j) * r, (i * theirOpts.length + j + 1) * r), 0),
    ),
  );
  const tPay = tCells.map((row) => row.map((c) => c.rate));
  const tEq = solveZeroSum(tPay, budget.fictitiousIterations);
  const bestReplies = theirOpts.map((_, j) => {
    let best = 0;
    tPay.forEach((row, i) => {
      if (row[j]! > tPay[best]![j]!) best = i;
    });
    return { their: j, mine: best, rate: tPay[best]![j]! };
  });
  const dominantIdx = tPay.findIndex((row) =>
    row.every((v, j) => v >= Math.max(...tPay.map((x) => x[j]!)) - 1e-9),
  );
  const isGuess =
    new Set(bestReplies.map((x) => x.mine)).size > 1 &&
    tEq.row.filter((x) => x >= 0.15).length >= 2;

  return {
    budget,
    battles,
    screening: { mine: myScreen, theirs: theirScreen },
    matrix: { mine: myTop.map((x) => x.species), theirs: theirTop.map((x) => x.species), cells },
    equilibrium: { mine: eq.row, theirs: eq.col, value: eq.value },
    safest: { index: safe.row, worstRate: safe.value },
    turnOne: {
      mine: speciesOf(mine, ca),
      theirs: speciesOf(theirs, cb),
      myOptions: myOpts.map((o) => label(mine, ca, o)),
      theirOptions: theirOpts.map((o) => label(theirs, cb, o)),
      cells: tCells,
      equilibrium: { mine: tEq.row, theirs: tEq.col, value: tEq.value },
      bestReplies,
      dominant: dominantIdx >= 0 ? dominantIdx : null,
      isGuess,
    },
  };
}
