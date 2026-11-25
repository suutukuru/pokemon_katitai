// `team:build`: search for strong teams around a fixed core by simulation against top teams.
//
//   stage 1  core + every pair from the pool (4 members), cheap selection analysis vs top teams
//   stage 2  the best stage-1 teams + every pair of the best remaining candidates (6 members)
//   stage 3  the finalists with a bigger budget, including search-vs-search battles
//
// Candidate sets come from usage statistics (most common set). With --tr, slow members get a
// Trick Room spread (no Speed points, a −Spe nature that keeps their main stat up).
import type { PokemonSet } from "@ca/schema";
import { displayName, type Dex } from "@ca/data";
import { formatShowdown, parseShowdown } from "@ca/ingest";
import {
  analyzeMatchup,
  budgetFrom,
  Dex as PsDex,
  simContext,
  type Executor,
  type MatchupAnalysis,
  type SimContext,
} from "@ca/sim";
import type { Io } from "./commands.js";
import { candidateSet } from "./fill.js";
import type { SimEnv } from "./sim-commands.js";

const MINUS_SPE: Record<string, string> = {
  atk: "Brave",
  spa: "Quiet",
  def: "Relaxed",
  spd: "Sassy",
};

/** Base stats from Showdown's dex for the format. */
function baseStats(ctx: SimContext, species: string): Record<string, number> {
  return PsDex.forFormat(ctx.format).species.get(species).baseStats;
}

/**
 * Trick Room version of a set: Speed points go to HP and the main stat, and the nature lowers
 * Speed while raising the stat the set relies on (physical / special attack, or defence for a
 * support set).
 */
export function trickRoomSet(ctx: SimContext, set: PokemonSet): PokemonSet {
  const dex = PsDex.forFormat(ctx.format);
  let phys = 0;
  let spec = 0;
  for (const m of set.moves) {
    const mv = dex.moves.get(m);
    if (mv.category === "Physical" || mv.id === "bodypress") phys++;
    if (mv.category === "Special") spec++;
  }
  const main = phys === 0 && spec === 0 ? "def" : phys >= spec ? "atk" : "spa";
  const sp = { ...set.sp };
  let free = sp.spe ?? 0;
  sp.spe = 0;
  for (const k of ["hp", main, "def", "spd"] as const) {
    const add = Math.min(free, 32 - (sp[k] ?? 0));
    sp[k] = (sp[k] ?? 0) + add;
    free -= add;
  }
  return { ...set, sp, nature: MINUS_SPE[main] as PokemonSet["nature"] };
}

export interface TeamScore {
  ids: string[];
  team: PokemonSet[];
  /** mean selection-equilibrium win rate over the opponents */
  avg: number;
  worst: number;
  worstLabel: string;
  rows: { label: string; value: number; bring: string[] }[];
  battles: number;
}

const eqOf = (a: MatchupAnalysis) => (a.strong ?? { equilibrium: a.equilibrium }).equilibrium;
const bringOf = (a: MatchupAnalysis) => {
  const src = a.strong ?? a.matrix;
  const eq = eqOf(a);
  return src.mine[eq.mine.indexOf(Math.max(...eq.mine))] ?? [];
};

export async function evaluateTeam(
  ctx: SimContext,
  ids: string[],
  team: PokemonSet[],
  opponents: { label: string; members: PokemonSet[] }[],
  executor: (mine: PokemonSet[], theirs: PokemonSet[]) => Executor,
  scale: number,
  strong: boolean,
  seed: number,
): Promise<TeamScore> {
  const budget = budgetFrom(ctx.params, scale);
  if (!strong) budget.strongConfigs = 0;
  budget.turnOptions = 2;
  budget.turnRollouts = 1;
  const rows: TeamScore["rows"] = [];
  let battles = 0;
  for (const o of opponents) {
    const a = await analyzeMatchup(ctx, team, o.members, executor(team, o.members), budget, seed);
    battles += a.battles;
    rows.push({ label: o.label, value: eqOf(a).value, bring: bringOf(a) });
  }
  const avg = rows.reduce((x, r) => x + r.value, 0) / Math.max(1, rows.length);
  const w = [...rows].sort((x, y) => x.value - y.value)[0];
  return { ids, team, avg, worst: w?.value ?? 0, worstLabel: w?.label ?? "", rows, battles };
}

export interface BuildDeps {
  executor: (mine: PokemonSet[], theirs: PokemonSet[]) => Executor;
  dex: Dex;
  write: (path: string, text: string) => void;
}

const opt = (args: string[], k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const nm = (id: string) => displayName("species", id);

/**
 * `team:build <core.txt> --pool a,b,c [--require trickroom] [--tr] [--top 8] [--beam 2]
 *  [--next 8] [--finalists 4] [--quick 0.08] [--final 0.3] [--seed 1] [--out reports/build]`
 */
export async function teamBuild(
  args: string[],
  env: SimEnv,
  deps: BuildDeps,
  io: Io,
): Promise<number> {
  const coreFile = args.find((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const pool = opt(args, "pool", "").split(",").filter(Boolean);
  if (!coreFile || pool.length < 2 || !env.topTeams || !env.resolveTeam || !env.usage) {
    io.err(
      "usage: pnpm team:build <core.txt> --pool a,b,c,... [--require trickroom] [--tr] [--top 8]",
    );
    return 2;
  }
  const ctx = simContext(env.pack, env.spec);
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  let core = parseShowdown(env.readText(coreFile), legal).members;
  const requireMove = opt(args, "require", "");
  const tr = args.includes("--tr");
  const trMaxSpe = Number(opt(args, "tr-max-speed", "70"));
  const seed = Number(opt(args, "seed", "1"));
  const opponents = env
    .topTeams(Number(opt(args, "top", "8")))
    .map((s) => env.resolveTeam!(s))
    .filter((o): o is NonNullable<typeof o> => !!o && o.members.length >= env.pack.rules.bringCount)
    .map((o) => ({ label: o.label, members: o.members }));
  // teams the user wants to be measured against as well (e.g. a rain team with Wide Guard)
  for (const f of opt(args, "extra-opp", "").split(",").filter(Boolean))
    opponents.push({
      label: f.replace(/^.*\//, "").replace(/\.txt$/, ""),
      members: parseShowdown(env.readText(f), legal).members,
    });

  // candidate sets (no second Mega Stone; Item Clause against the core)
  const coreItems = new Set<string>(core.map((m) => m.item).filter((x): x is string => !!x));
  const stones = new Set(deps.dex.megaStones().keys());
  const ok = (team: PokemonSet[]) => {
    const items = team.map((m) => m.item).filter(Boolean);
    if (new Set(items).size !== items.length) return false;
    if (new Set(team.map((m) => m.species)).size !== team.length) return false;
    return true;
  };
  const hasRequired = (team: PokemonSet[]) =>
    !requireMove || team.some((m) => m.moves.includes(requireMove));
  // a team's members are built in order so each takes its most common item still free
  const memo = new Map<string, PokemonSet[] | null>();
  const build = (add: string[]): PokemonSet[] | undefined => {
    const key = add.join(",");
    if (memo.has(key)) return memo.get(key) ?? undefined;
    const used = new Set([...coreItems, ...stones]);
    const out: PokemonSet[] = [...core];
    for (const id of add) {
      let s = candidateSet(id, env.usage!, deps.dex, used);
      if (!s || out.some((m) => m.species === s!.species)) {
        memo.set(key, null);
        return undefined;
      }
      if (s.item) used.add(s.item);
      if (tr && (baseStats(ctx, s.species)["spe"] ?? 999) <= trMaxSpe) s = trickRoomSet(ctx, s);
      out.push(s);
    }
    const t = ok(out) ? out : null;
    memo.set(key, t);
    return t ?? undefined;
  };
  // members named with --with join the core (usage-based sets, Trick Room spread with --tr)
  const withIds = opt(args, "with", "").split(",").filter(Boolean);
  if (withIds.length) {
    const t = build(withIds);
    if (!t) {
      io.err(`--with ${withIds.join(",")}: 型を作れません（使用率データ・アイテム被りを確認）`);
      return 1;
    }
    core = t;
    coreItems.clear();
    for (const m of core) if (m.item) coreItems.add(m.item);
    memo.clear();
  }
  const sets = new Map(
    pool.flatMap((id) => {
      const t = build([id]);
      return t ? [[id, t.at(-1)!] as const] : [];
    }),
  );
  const ids = [...sets.keys()];
  const combos = (xs: string[], k: number): string[][] =>
    k === 0
      ? [[]]
      : xs.flatMap((a, i) => combos(xs.slice(i + 1), k - 1).map((rest) => [a, ...rest]));
  const pairs = (xs: string[]) =>
    xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b] as [string, string]));
  const log = (stage: string, s: TeamScore) =>
    io.err(
      `  [${stage}] ${s.ids.map(nm).join("・")}: 平均 ${pct(s.avg)}（最低 ${pct(s.worst)} vs ${s.worstLabel}）`,
    );

  // stage 1
  const quick = Number(opt(args, "quick", "0.08"));
  const s1: TeamScore[] = [];
  const k1 = Math.max(0, env.pack.rules.bringCount - core.length);
  const first = combos(ids, k1).filter((c) => {
    const t = build(c);
    return !!t && hasRequired(t);
  });
  io.err(
    `段階1: 核 ${core.map((m) => nm(m.species)).join("・")} ＋ 候補${k1}体（${first.length}通り）× 上位${opponents.length}構築`,
  );
  for (const c of first) {
    const team = build(c)!;
    const r = await evaluateTeam(ctx, c, team, opponents, deps.executor, quick, false, seed);
    s1.push(r);
    log("1", r);
  }
  s1.sort((x, y) => y.avg - x.avg);
  // stage 2
  const beam = s1.slice(0, Number(opt(args, "beam", "2")));
  // the best remaining candidates by how often they appear near the top of stage 1
  const score = new Map<string, number>();
  s1.forEach((r, rank) =>
    r.ids.forEach((id) => score.set(id, Math.max(score.get(id) ?? -1, r.avg - rank * 1e-6))),
  );
  // with a 4-member core there is no stage-1 choice: every candidate goes on to stage 2
  const next = (
    score.size ? [...score.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id) : ids
  ).slice(0, Number(opt(args, "next", "8")));
  const s2: TeamScore[] = [];
  for (const b of beam) {
    const rest = next.filter((id) => !b.ids.includes(id));
    for (const [x, y] of pairs(rest)) {
      const team = build([...b.ids, x, y]);
      if (!team) continue;
      const r = await evaluateTeam(
        ctx,
        [...b.ids, x, y],
        team,
        opponents,
        deps.executor,
        quick,
        false,
        seed,
      );
      s2.push(r);
      log("2", r);
    }
  }
  s2.sort((x, y) => y.avg - x.avg);
  // stage 3
  const final = Number(opt(args, "final", "0.3"));
  const fin: TeamScore[] = [];
  for (const c of s2.slice(0, Number(opt(args, "finalists", "4")))) {
    const r = await evaluateTeam(
      ctx,
      c.ids,
      c.team,
      opponents,
      deps.executor,
      final,
      true,
      seed + 1,
    );
    fin.push(r);
    log("3", r);
  }
  fin.sort((x, y) => y.avg - x.avg);

  const outDir = opt(args, "out", "reports/build");
  io.out(
    `候補 ${ids.length}体、段階1 ${s1.length}通り → 段階2 ${s2.length}通り → 最終 ${fin.length}通り（上位${opponents.length}構築に対する選出の読み合いの期待勝率）`,
  );
  fin.forEach((r, i) => {
    io.out(`\n${i + 1}位: ${[...core.map((m) => m.species), ...r.ids].map(nm).join(" / ")}`);
    io.out(`  平均 ${pct(r.avg)}、最低 ${pct(r.worst)}（${r.worstLabel}）、${r.battles}戦`);
    for (const row of r.rows)
      io.out(
        `  vs ${row.label}: ${pct(row.value)}  推奨 ${row.bring.slice(0, 2).map(nm).join("・")} ／ 後ろ ${row.bring.slice(2).map(nm).join("・")}`,
      );
    deps.write(`${outDir}/${i + 1}.txt`, formatShowdown(r.team, "en"));
  });
  return 0;
}
