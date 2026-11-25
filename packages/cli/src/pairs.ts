// `team:pairs`: which two Pokémon do best as a pair against the most common opposing pairs.
//
// Candidates are the top-usage Pokémon (most common set each). Opponents are the pairs that most
// often appear together (usage × teammate share), weighted by that frequency. Every candidate pair
// plays 2-vs-2 games against every opposing pair (half from each side, shared seeds); the best
// pairs are then re-played with the search on both sides (each side planning only from what it
// can know).
import type { PokemonSet, UsageSnapshot } from "@ca/schema";
import { displayName, type Dex } from "@ca/data";
import {
  mixSeed,
  searchBudgetFrom,
  simContext,
  type BattleJob,
  type BattleResult,
  type Config,
  type Executor,
  type ReplayData,
  Dex as PsDex,
} from "@ca/sim";
import { trickRoomSet } from "./build.js";
import { renderPairBook, type PairBookMatch } from "./pairbook.js";
import type { Io } from "./commands.js";
import { candidateSet } from "./fill.js";
import type { SimEnv } from "./sim-commands.js";

const PAIR: Config = [0, 1] as unknown as Config;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const nm = (id: string) => displayName("species", id);

export interface PairDeps {
  executor: (mine: PokemonSet[], theirs: PokemonSet[]) => Executor;
  dex: Dex;
}

/** Most-used species (one entry per species, usage summed over Mega / non-Mega variants). */
export function topSpecies(u: UsageSnapshot, n: number): { id: string; usage: number }[] {
  const by = new Map<string, number>();
  for (const e of u.entries)
    if (e.distributions) by.set(e.species, (by.get(e.species) ?? 0) + e.usage);
  return [...by.entries()]
    .map(([id, usage]) => ({ id, usage }))
    .sort((a, b) => b.usage - a.usage || a.id.localeCompare(b.id))
    .slice(0, n);
}

/** How often A and B are on the same team: usage(A) × share of A's teams that have B (symmetrised). */
export function commonPairs(
  u: UsageSnapshot,
  n: number,
): { ids: [string, string]; weight: number }[] {
  const usage = new Map<string, number>();
  const mates = new Map<string, Map<string, number>>();
  for (const e of u.entries) {
    if (!e.distributions) continue;
    usage.set(e.species, (usage.get(e.species) ?? 0) + e.usage);
    const m = mates.get(e.species) ?? new Map<string, number>();
    for (const t of e.distributions.teammates) m.set(t.id, Math.max(m.get(t.id) ?? 0, t.share));
    mates.set(e.species, m);
  }
  const out = new Map<string, { ids: [string, string]; weight: number }>();
  for (const [a, m] of mates)
    for (const [b, share] of m) {
      if (a === b || !usage.has(b)) continue;
      const ids = [a, b].sort() as [string, string];
      const k = ids.join("+");
      const w = (usage.get(a)! * share) / 2;
      const prev = out.get(k);
      out.set(k, { ids, weight: (prev?.weight ?? 0) + w });
    }
  return [...out.values()]
    .sort((x, y) => y.weight - x.weight || x.ids.join().localeCompare(y.ids.join()))
    .slice(0, n);
}

/** A legal pair (Item Clause, at most one Mega Stone), built from usage sets. */
function makePair(ids: [string, string], u: UsageSnapshot, dex: Dex): PokemonSet[] | undefined {
  const stones = new Set(dex.megaStones().keys());
  const used = new Set<string>();
  const out: PokemonSet[] = [];
  for (const id of ids) {
    const s = candidateSet(id, u, dex, used);
    if (!s) return undefined;
    if (s.item) used.add(s.item);
    out.push(s);
  }
  if (out.filter((m) => m.item && stones.has(m.item)).length > 1) {
    // keep the first one's stone, give the second its most common non-stone item
    const second = candidateSet(ids[1], u, dex, new Set([...used, ...stones]));
    if (!second) return undefined;
    out[1] = second;
  }
  return out;
}

export interface PairResult {
  ids: [string, string];
  /** frequency-weighted win rate against the opposing pairs */
  score: number;
  games: number;
  vs: { ids: [string, string]; weight: number; rate: number }[];
}

async function scorePair(
  mine: PokemonSet[],
  ids: [string, string],
  opps: { ids: [string, string]; weight: number; team: PokemonSet[] }[],
  deps: PairDeps,
  games: number,
  seed: number,
  best?: { budget: ReturnType<typeof searchBudgetFrom> },
): Promise<PairResult> {
  const half = Math.max(1, Math.round(games / 2));
  const vs: PairResult["vs"] = [];
  let total = 0;
  let wsum = 0;
  let n = 0;
  const results = await Promise.all(
    opps.map(async (o, j) => {
      const seeds = Array.from({ length: half }, (_, k) => mixSeed(seed, j, k));
      const jobs: BattleJob[] = seeds.map((s) => ({ a: PAIR, b: PAIR, seed: s }));
      const run = (a: PokemonSet[], b: PokemonSet[]): Promise<BattleResult[]> =>
        best
          ? deps.executor(a, b).bestPlay!(jobs.map((x) => ({ ...x, budget: best.budget })))
          : deps.executor(a, b).run(jobs);
      const [asP1, asP2] = await Promise.all([run(mine, o.team), run(o.team, mine)]);
      const pts =
        asP1.reduce((x, r) => x + (r.winner === 0 ? 1 : r.winner === null ? 0.5 : 0), 0) +
        asP2.reduce((x, r) => x + (r.winner === 1 ? 1 : r.winner === null ? 0.5 : 0), 0);
      return { o, rate: pts / (asP1.length + asP2.length), games: asP1.length + asP2.length };
    }),
  );
  for (const { o, rate, games: g } of results) {
    vs.push({ ids: o.ids, weight: o.weight, rate });
    total += rate * o.weight;
    wsum += o.weight;
    n += g;
  }
  return { ids, score: total / Math.max(1e-9, wsum), games: n, vs };
}

const opt = (args: string[], k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

/**
 * `team:pairs [--pool 30] [--opp 24] [--games 16] [--final 12] [--final-games 8] [--think 0.2]
 *  [--include a,b] [--seed 1]`
 */
export async function teamPairs(
  args: string[],
  env: SimEnv,
  deps: PairDeps,
  io: Io,
): Promise<number> {
  const u = env.usage;
  if (!u) {
    io.err("使用率データがありません");
    return 1;
  }
  const ctx = simContext(env.pack, env.spec);
  const seed = Number(opt(args, "seed", "1"));
  const legal = new Set(env.pack.legal.species);
  const pool = [
    ...new Set([
      ...topSpecies(u, Number(opt(args, "pool", "30"))).map((x) => x.id),
      ...opt(args, "include", "").split(",").filter(Boolean),
    ]),
  ].filter((id) => legal.has(id));
  const opps = commonPairs(u, Number(opt(args, "opp", "24")))
    .filter((p) => p.ids.every((id) => legal.has(id)))
    .flatMap((p) => {
      const team = makePair(p.ids, u, deps.dex);
      return team ? [{ ...p, team }] : [];
    });
  // optional shaping of my candidates: Trick Room spreads, a required move on the first member
  const tr = args.includes("--tr");
  const trMax = Number(opt(args, "tr-max-speed", "70"));
  const ensure = opt(args, "ensure", "");
  const shape = (team: PokemonSet[], firstIdx: number | null): PokemonSet[] =>
    team.map((m, i) => {
      let x = m;
      if (ensure && i === firstIdx && !x.moves.includes(ensure)) {
        const d = u.entries.find((e) => e.species === x.species && e.distributions)?.distributions;
        if (d?.moves.some((mm) => mm.id === ensure))
          x = { ...x, moves: [...x.moves.slice(0, 3), ensure] };
      }
      if (
        tr &&
        (PsDex.forFormat(ctx.format).species.get(x.species).baseStats["spe"] ?? 999) <= trMax
      )
        x = trickRoomSet(ctx, x);
      return x;
    });
  const first = opt(args, "first", "")
    .split(",")
    .filter((x) => legal.has(x));
  const second = opt(args, "second", "")
    .split(",")
    .filter((x) => legal.has(x));
  const cands: { ids: [string, string]; team: PokemonSet[] }[] = [];
  const seen = new Set<string>();
  const add = (ids: [string, string], firstIdx: number | null) => {
    const key = [...ids].sort().join("+");
    if (ids[0] === ids[1] || seen.has(key)) return;
    seen.add(key);
    const team = makePair(ids, u, deps.dex);
    if (team) cands.push({ ids, team: shape(team, firstIdx) });
  };
  if (first.length && second.length) {
    for (const a of first) for (const b of second) add([a, b], 0);
  } else pool.forEach((a, i) => pool.slice(i + 1).forEach((b) => add([a, b], null)));
  // opposing pairs the user wants to see separately (not part of the weighted score)
  const focus = opt(args, "focus", "")
    .split(",")
    .filter(Boolean)
    .map((x) => x.split("+").sort() as [string, string]);
  io.err(
    `段階1: ${first.length ? `${first.length}体 × ${second.length}体` : `使用率上位${pool.length}体`}の組み合わせ ${cands.length}組${tr ? "（遅いポケモンはトリックルーム用の配分）" : ""} × よく一緒に使われる相手の2体 ${opps.length}組（${u.source.title}）`,
  );
  const games = Number(opt(args, "games", "16"));
  const s1: PairResult[] = [];
  for (const [i, c] of cands.entries()) {
    s1.push(await scorePair(c.team, c.ids, opps, deps, games, seed));
    if ((i + 1) % 25 === 0) io.err(`  … ${i + 1}/${cands.length}組`);
  }
  s1.sort((x, y) => y.score - x.score || x.ids.join().localeCompare(y.ids.join()));
  io.err("段階1の上位:");
  const focusOf = (r: PairResult) =>
    focus
      .map((f) => r.vs.find((v) => v.ids.join() === f.join()))
      .filter((v): v is PairResult["vs"][number] => !!v)
      .map((v) => `vs ${v.ids.map(nm).join("＋")} ${pct(v.rate)}`)
      .join(" / ");
  for (const r of s1.slice(0, 15))
    io.err(
      `  ${r.ids.map(nm).join("＋")}: ${pct(r.score)}${focus.length ? `（${focusOf(r)}）` : ""}`,
    );

  // stage 2: search on both sides (hidden information sampled) for the best pairs
  const fin = Number(opt(args, "final", "12"));
  const budget = searchBudgetFrom(ctx.params, Number(opt(args, "think", "0.2")));
  const s2: (PairResult & { quick: number })[] = [];
  for (const r of s1.slice(0, fin)) {
    const c = cands.find((x) => x.ids.join() === r.ids.join())!;
    const b = await scorePair(
      c.team,
      c.ids,
      opps,
      deps,
      Number(opt(args, "final-games", "8")),
      seed + 1,
      {
        budget,
      },
    );
    s2.push({ ...b, quick: r.score });
    io.err(`  [探索] ${r.ids.map(nm).join("＋")}: ${pct(b.score)}（方針のみ ${pct(r.score)}）`);
  }
  s2.sort((x, y) => y.score - x.score);
  io.out(
    `使用率上位の2体の組み合わせ ${cands.length}組を、よく一緒に使われる相手の2体 ${opps.length}組（使用頻度で重み付け）と2対2で対戦させた結果`,
  );
  io.out(
    `上位${s2.length}組は両者が毎ターン探索（自分から見える情報だけ）で再対戦。勝率は相手の組の頻度で重み付けした平均。\n`,
  );
  s2.forEach((r, i) => {
    const sorted = [...r.vs].sort((x, y) => y.rate - x.rate);
    io.out(
      `${i + 1}. ${r.ids.map(nm).join(" ＋ ")}  ${pct(r.score)}（方針のみ ${pct(r.quick)}、${r.games}戦）${focus.length ? `  ${focusOf(r)}` : ""}`,
    );
    io.out(
      `   得意: ${sorted
        .slice(0, 3)
        .map((v) => `${v.ids.map(nm).join("＋")} ${pct(v.rate)}`)
        .join(" / ")}`,
    );
    io.out(
      `   苦手: ${sorted
        .slice(-3)
        .reverse()
        .map((v) => `${v.ids.map(nm).join("＋")} ${pct(v.rate)}`)
        .join(" / ")}`,
    );
  });
  return 0;
}

export interface PairBookDeps {
  dex: Dex;
  /** best-play games (each side plans from its own view), results in task order */
  play: (
    tasks: {
      mine: PokemonSet[];
      theirs: PokemonSet[];
      ca: Config;
      cb: Config;
      seed: number;
      budget: ReturnType<typeof searchBudgetFrom>;
    }[],
    onDone: (done: number) => void,
  ) => Promise<ReplayData[]>;
  write: (path: string, text: string) => void;
}

/**
 * `report:pairbook <a,b> [--opp 40] [--extra x+y,z+w] [--games 6] [--think 0.6] [--seed 1]
 *  [--out reports/pairbook]`: every game of the pair against the most common opposing pairs
 *  (plus any listed with --extra), with what was considered at each turn, as a browser page.
 */
export async function pairBookCommand(
  args: string[],
  env: SimEnv,
  deps: PairBookDeps,
  io: Io,
): Promise<number> {
  const u = env.usage;
  const ids = (args.find((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "")
    .split(",")
    .filter(Boolean) as [string, string];
  if (!u || ids.length !== 2) {
    io.err(
      "usage: pnpm report:pairbook garchomp,staraptor [--opp 40] [--extra sableye+archaludon]",
    );
    return 2;
  }
  const ctx = simContext(env.pack, env.spec);
  const legal = new Set(env.pack.legal.species);
  const mine = makePair(ids, u, deps.dex);
  if (!mine) {
    io.err(`${ids.join(",")}: 型を作れません`);
    return 1;
  }
  const extras = opt(args, "extra", "")
    .split(",")
    .filter(Boolean)
    .map((x) => x.split("+").sort() as [string, string]);
  const common = commonPairs(u, Number(opt(args, "opp", "40"))).filter((p) =>
    p.ids.every((id) => legal.has(id)),
  );
  const list = [
    ...common.map((p) => ({ ...p, extra: false })),
    ...extras
      .filter((e) => !common.some((p) => p.ids.join() === e.join()))
      .map((e) => ({ ids: e, weight: 0, extra: true })),
  ].flatMap((p) => {
    const team = makePair(p.ids, u, deps.dex);
    if (!team) io.err(`skip ${p.ids.join("+")}: 型を作れません`);
    return team ? [{ ...p, team }] : [];
  });
  const games = Number(opt(args, "games", "6"));
  const seed = Number(opt(args, "seed", "1"));
  const budget = searchBudgetFrom(ctx.params, Number(opt(args, "think", "0.6")));
  const tasks = list.flatMap((p, j) =>
    Array.from({ length: games }, (_, k) => ({
      mine,
      theirs: p.team,
      ca: PAIR,
      cb: PAIR,
      seed: mixSeed(seed, j, k),
      budget,
    })),
  );
  io.err(`${list.length}組 × ${games}戦 = ${tasks.length}戦（両者が毎ターン探索）`);
  const res = await deps.play(tasks, (d) => d % 20 === 0 && io.err(`  … ${d}/${tasks.length}`));
  const matches: PairBookMatch[] = list.map((p, j) => ({
    opp: p.ids,
    weight: p.weight,
    extra: p.extra,
    games: res.slice(j * games, (j + 1) * games),
  }));
  const title = `${ids.map(nm).join("＋")} 対面ブック`;
  const html = renderPairBook({
    title,
    mine,
    opponents: Object.fromEntries(list.map((p) => [p.ids.join("+"), p.team])),
    matches,
    method: `よく一緒に使われる2体 ${common.length}組${extras.length ? `＋指定 ${extras.length}組` : ""}と、2対2で各${games}戦。両者とも毎ターン、自分から見える情報だけで候補を総当たりして読み合いを解く（探索の計算量 ${opt(args, "think", "0.6")}）。`,
    source: `${u.source.title}。型は各ポケモンの最多の型（推定）。`,
  });
  const out = opt(args, "out", "reports/pairbook");
  const file = `${out}/${ids.join("-")}.html`;
  deps.write(file, html);
  io.out(file);
  const wins = res.filter((r) => r.result.winner === 0).length;
  io.out(`${tasks.length}戦 ${wins}勝（${pct(wins / Math.max(1, tasks.length))}）`);
  return 0;
}
