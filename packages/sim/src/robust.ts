// Selection that holds up against counter-picks (ADR-0013).
//
// analyzeMatchup solves the selection game only among each side's top screened brings, so a
// bring that the screening never favoured (e.g. one without the opponent's usual weather setter)
// is never considered — even though the opponent sees our six at team preview and may pick it to
// counter us. Here the opponent keeps ALL its brings:
//   1) screen my brings and keep the best `myTop`,
//   2) play every kept bring against every opposing bring (policy games, shared seeds),
//   3) solve that matrix (my kept brings × all their brings) as a zero-sum game,
//   4) re-play the cells that matter — the equilibrium's support and each of my candidates'
//      worst counter-picks — with search on both sides, and solve again on those cells.
import type { PokemonSet } from "@ca/schema";
import type { BattleJob, BestPlayJob, Executor, Rate } from "./analyze.js";
import { maximin, solveZeroSum, wilson } from "./game.js";
import { mixSeed } from "./rng.js";
import { allConfigs, type BattleResult, type Config, type SimContext } from "./runner.js";
import type { SearchBudget } from "./search.js";

export interface RobustOptions {
  /** my brings kept after screening */
  myTop: number;
  /** screening games per my bring (against opposing brings in turn) */
  screenGames: number;
  /** policy games per (my kept bring × their bring) */
  games: number;
  /** my candidates re-played with search */
  rows: number;
  /** worst counter-picks per candidate added to the re-played columns */
  counters: number;
  /** equilibrium support columns (by probability) re-played */
  support: number;
  /** search games per re-played cell */
  searchGames: number;
  search: SearchBudget;
  iterations: number;
}

export interface RobustSelection {
  mine: { config: Config; species: string[] }[];
  theirs: { config: Config; species: string[] }[];
  /** policy-game win rates, my kept brings × all their brings */
  mc: Rate[][];
  mcEq: { mine: number[]; theirs: number[]; value: number };
  /** re-played cells (indices into mine / theirs) */
  rows: number[];
  cols: number[];
  /** search-game rates for rows × cols (shrunk toward the policy rate by 2 games) */
  search: Rate[][];
  searchEq: { mine: number[]; theirs: number[]; value: number };
  /** maximin over the re-played cells: the bring whose worst counter is best */
  safest: { row: number; worst: number; col: number };
  battles: number;
}

const rate = (rs: BattleResult[]): Rate => {
  const wins = rs.reduce((a, r) => a + (r.winner === 0 ? 1 : r.winner === null ? 0.5 : 0), 0);
  return {
    wins,
    games: rs.length,
    rate: rs.length ? wins / rs.length : 0,
    ci: wilson(wins, rs.length),
  };
};

export async function analyzeSelectionRobust(
  ctx: SimContext,
  mine: readonly PokemonSet[],
  theirs: readonly PokemonSet[],
  exec: Executor,
  o: RobustOptions,
  seed: number,
  onProgress?: (stage: string, total: number) => void,
): Promise<RobustSelection> {
  const bring = ctx.pack.rules.bringCount;
  const myAll = allConfigs(mine.length, Math.min(bring, mine.length));
  const theirAll = allConfigs(theirs.length, Math.min(bring, theirs.length));
  const sp = (team: readonly PokemonSet[], c: Config) => c.map((i) => team[i]!.species);
  let battles = 0;

  // 1) screen my brings against the opposing brings in turn
  const screen: BattleJob[] = [];
  myAll.forEach((c, i) => {
    for (let k = 0; k < o.screenGames; k++)
      screen.push({
        a: c,
        b: theirAll[(i * 7 + k * 11) % theirAll.length]!,
        seed: mixSeed(seed, 1, i, k),
      });
  });
  onProgress?.("screen", screen.length);
  const sr = await exec.run(screen);
  battles += sr.length;
  const myRank = myAll
    .map((c, i) => ({ c, i, r: rate(sr.slice(i * o.screenGames, (i + 1) * o.screenGames)).rate }))
    .sort((x, y) => y.r - x.r || x.i - y.i)
    .slice(0, o.myTop);
  const myKept = myRank.map((x) => x.c);

  // 2) every kept bring × every opposing bring (the k-th game of each cell shares a seed)
  const jobs: BattleJob[] = [];
  myKept.forEach((a) =>
    theirAll.forEach((b) => {
      for (let k = 0; k < o.games; k++) jobs.push({ a, b, seed: mixSeed(seed, 2, k) });
    }),
  );
  onProgress?.("matrix", jobs.length);
  const mr = await exec.run(jobs);
  battles += mr.length;
  const N = theirAll.length;
  const mc = myKept.map((_, i) =>
    theirAll.map((_, j) => rate(mr.slice((i * N + j) * o.games, (i * N + j + 1) * o.games))),
  );
  const eq = solveZeroSum(
    mc.map((r) => r.map((c) => c.rate)),
    o.iterations,
  );

  // 3) the cells that matter: my best candidates × (their likely brings ∪ my candidates' counters)
  const rows = myKept
    .map((_, i) => i)
    .sort(
      (x, y) =>
        eq.row[y]! - eq.row[x]! ||
        Math.min(...mc[y]!.map((c) => c.rate)) - Math.min(...mc[x]!.map((c) => c.rate)),
    )
    .slice(0, o.rows)
    .sort((x, y) => x - y);
  const colSet = new Set<number>();
  eq.col
    .map((p, j) => ({ p, j }))
    .filter((x) => x.p >= 0.01)
    .sort((x, y) => y.p - x.p)
    .slice(0, o.support)
    .forEach((x) => colSet.add(x.j));
  for (const i of rows)
    mc[i]!.map((c, j) => ({ r: c.rate, j }))
      .sort((x, y) => x.r - y.r || x.j - y.j)
      .slice(0, o.counters)
      .forEach((x) => colSet.add(x.j));
  const cols = [...colSet].sort((x, y) => x - y);
  const sj: BestPlayJob[] = [];
  rows.forEach((i) =>
    cols.forEach((j) => {
      for (let k = 0; k < o.searchGames; k++)
        sj.push({
          a: myKept[i]!,
          b: theirAll[j]!,
          seed: mixSeed(seed, 3, i, j, k),
          budget: o.search,
        });
    }),
  );
  onProgress?.("search", sj.length);
  const br = await exec.bestPlay!(sj);
  battles += br.length;
  const g = o.searchGames;
  const search = rows.map((i, x) =>
    cols.map((j, y) => {
      const r = rate(br.slice((x * cols.length + y) * g, (x * cols.length + y + 1) * g));
      return { ...r, rate: (r.wins + 2 * mc[i]![j]!.rate) / (r.games + 2) };
    }),
  );
  const pay = search.map((r) => r.map((c) => c.rate));
  const seq = solveZeroSum(pay, o.iterations);
  const mm = maximin(pay);
  const worstCol = pay[mm.row]!.indexOf(Math.min(...pay[mm.row]!));
  return {
    mine: myKept.map((c) => ({ config: c, species: sp(mine, c) })),
    theirs: theirAll.map((c) => ({ config: c, species: sp(theirs, c) })),
    mc,
    mcEq: { mine: eq.row, theirs: eq.col, value: eq.value },
    rows,
    cols,
    search,
    searchEq: { mine: seq.row, theirs: seq.col, value: seq.value },
    safest: { row: mm.row, worst: mm.value, col: worstCol },
    battles,
  };
}
