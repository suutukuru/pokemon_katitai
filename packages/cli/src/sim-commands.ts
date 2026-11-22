import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";
import {
  analyzeMatchup,
  budgetFrom,
  inProcessExecutor,
  simContext,
  type Executor,
  type MatchupAnalysis,
  type OptionLabel,
  type Rate,
} from "@ca/sim";
import { parseShowdown } from "@ca/ingest";
import type { Io } from "./commands.js";
import type { TeamEnv } from "./team-commands.js";

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const name = (id: string) => displayName("species", id);
const names = (ids: string[]) =>
  `${ids.slice(0, 2).map(name).join("・")} / 後ろ ${ids.slice(2).map(name).join("・")}`;
const rateStr = (r: Rate) =>
  `${pct(r.rate)}（${r.games}戦、95%区間 ${pct(r.ci[0])}〜${pct(r.ci[1])}）`;

function optionStr(o: OptionLabel): string {
  return o.slots
    .map((s) => {
      if (!s.moveId) return `${name(s.species)}:交代/なし`;
      const tgt = s.targetSpecies ? `→${name(s.targetSpecies)}` : "";
      return `${name(s.species)}${s.mega ? "(メガ)" : ""}:${displayName("moves", s.moveId)}${tgt}`;
    })
    .join(" ＋ ");
}

/** Render the analysis as a Japanese report. Every number comes from the simulation result. */
export function formatAnalysis(a: MatchupAnalysis, regulation: string): string[] {
  const out: string[] = [];
  out.push(
    `シミュレーション ${a.battles}戦（レギュレーション ${regulation}、対戦エンジン: Pokémon Showdown の Champions ルール）`,
  );
  out.push(
    "※ 両者とも同じ確率的なAIで行動します。相手の実際の動きとは異なる可能性があります（推測を含む）。",
  );
  out.push("\n■ 選出と初手（全組み合わせの予備戦、上位）");
  for (const s of a.screening.mine.slice(0, 5))
    out.push(`  ${names(s.species)}  勝率 ${rateStr(s)}`);
  out.push("\n■ 相手の有力な選出（予備戦で相手の勝率が高い順）");
  for (const s of a.screening.theirs.slice(0, 5))
    out.push(`  ${names(s.species)}  相手勝率 ${rateStr(s)}`);
  out.push("\n■ 選出の読み合い（行=自分、列=相手、数字=自分の勝率）");
  a.matrix.theirs.forEach((t, j) =>
    out.push(
      `  相手${j + 1}: ${names(t)}（相手がこれを選ぶ割合 ${pct(a.equilibrium.theirs[j]!)}）`,
    ),
  );
  a.matrix.mine.forEach((m, i) => {
    out.push(`  自分${i + 1}: ${names(m)}（推奨の割合 ${pct(a.equilibrium.mine[i]!)}）`);
    out.push(
      `        ${a.matrix.cells[i]!.map((c, j) => `相手${j + 1} ${pct(c.rate)}`).join(" / ")}`,
    );
  });
  const best = a.equilibrium.mine.indexOf(Math.max(...a.equilibrium.mine));
  out.push(
    `  → 最適な混ぜ方での期待勝率 ${pct(a.equilibrium.value)}。最も多く選ぶべき選出: 自分${best + 1}`,
  );
  out.push(
    `  → 相手が最善の選出をしても最低限取れる選出（安全策）: 自分${a.safest.index + 1}（最低勝率 ${pct(a.safest.worstRate)}）`,
  );
  if (a.strong) {
    const st = a.strong;
    out.push(
      `\n■ 最善手同士の対戦での評価（上位${st.mine.length}×${st.theirs.length}の選出を、毎ターン両者が読み合いの最適な行動を探索して選ぶ対戦 ${st.games}戦で評価し直し）`,
    );
    st.theirs.forEach((t, j) =>
      out.push(
        `  相手${j + 1}: ${names(t)}（相手がこれを選ぶ割合 ${pct(st.equilibrium.theirs[j]!)}）`,
      ),
    );
    st.mine.forEach((m, i) => {
      out.push(`  自分${i + 1}: ${names(m)}（推奨の割合 ${pct(st.equilibrium.mine[i]!)}）`);
      out.push(`        ${st.cells[i]!.map((c, j) => `相手${j + 1} ${pct(c.rate)}`).join(" / ")}`);
    });
    const sb = st.equilibrium.mine.indexOf(Math.max(...st.equilibrium.mine));
    out.push(
      `  → 推奨選出: ${names(st.mine[sb]!)}（期待勝率 ${pct(st.equilibrium.value)}）／安全策: ${names(st.mine[st.safest.index]!)}（最低 ${pct(st.safest.worstRate)}）`,
    );
  }
  const t = a.turnOne;
  out.push(`\n■ 1ターン目の択（自分 ${names(t.mine)} vs 相手 ${names(t.theirs)}）`);
  t.theirOptions.forEach((o, j) =>
    out.push(
      `  相手の行動${j + 1}: ${optionStr(o)}（相手が選ぶ割合 ${pct(t.equilibrium.theirs[j]!)}）`,
    ),
  );
  t.myOptions.forEach((o, i) => {
    out.push(`  自分の行動${i + 1}: ${optionStr(o)}（推奨の割合 ${pct(t.equilibrium.mine[i]!)}）`);
    out.push(`        ${t.cells[i]!.map((c, j) => `相手${j + 1} ${pct(c.rate)}`).join(" / ")}`);
  });
  if (t.dominant !== null)
    out.push(
      `  → 自分の行動${t.dominant + 1} は相手がどう動いても最も勝率が高い（択にならない）。`,
    );
  else if (t.isGuess) {
    out.push("  → 択になっています。相手の行動ごとの最善手:");
    for (const r of t.bestReplies)
      out.push(`     相手が行動${r.their + 1}なら 自分の行動${r.mine + 1}（勝率 ${pct(r.rate)}）`);
  } else out.push("  → はっきりした択はありません。推奨の割合が最も高い行動を基本に。");
  return out;
}

export interface SimEnv extends TeamEnv {
  executor?: (
    mine: PokemonSet[],
    theirs: PokemonSet[],
  ) => Executor & { close?: () => Promise<void> };
  /** Resolve "pokedb:M-7:4"-style specs (team DB + usage estimate). */
  resolveTeam?: (spec: string) => ResolvedOpponent | undefined;
  /** Top recorded teams for this regulation, best rank first. */
  topTeams?: (limit: number) => string[];
}

export interface ResolvedOpponent {
  members: PokemonSet[];
  label: string;
  /** Where the estimated fields came from. */
  note?: string;
  /** Species left out because no set could be estimated. */
  missing?: string[];
}

/** `sim <自分.txt> <相手.txt> [--seed 1] [--scale 1] [--json]` */
export async function simCommand(args: string[], env: SimEnv, io: Io): Promise<number> {
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter(
    (x, i) =>
      !x.startsWith("--") && !["--seed", "--scale", "--workers"].includes(args[i - 1] ?? ""),
  );
  const [mineFile, theirFile] = positional;
  if (!mineFile || !theirFile) {
    io.err(
      "usage: pnpm sim <自分のパーティ.txt> <相手のパーティ.txt> [--seed 1] [--scale 1] [--workers 4] [--json]",
    );
    return 2;
  }
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  const load = (f: string) => {
    const resolved = env.resolveTeam?.(f);
    if (resolved) {
      if (resolved.note) io.err(`[${resolved.label}] ${resolved.note}`);
      return { members: resolved.members };
    }
    const r = parseShowdown(env.readText(f), legal);
    for (const i of r.issues.filter((x) => x.severity === "error"))
      io.err(`[${f}] ${i.line ?? ""}行目: ${i.message}`);
    return r;
  };
  const mine = load(mineFile);
  const theirs = load(theirFile);
  if (
    mine.members.length < env.pack.rules.bringCount ||
    theirs.members.length < env.pack.rules.bringCount
  ) {
    io.err(`どちらのパーティも${env.pack.rules.bringCount}匹以上必要です`);
    return 1;
  }
  const ctx = simContext(env.pack, env.spec);
  const budget = budgetFrom(env.pack.weights.simulation, Number(opt("scale") ?? 1));
  const exec = env.executor
    ? env.executor(mine.members, theirs.members)
    : inProcessExecutor(ctx, mine.members, theirs.members);
  try {
    const a = await analyzeMatchup(
      ctx,
      mine.members,
      theirs.members,
      exec,
      budget,
      Number(opt("seed") ?? 1),
      (stage, _d, total) => io.err(`… ${stage}: ${total}戦`),
    );
    if (args.includes("--json")) io.out(JSON.stringify(a, null, 2));
    else for (const l of formatAnalysis(a, env.pack.id)) io.out(l);
  } finally {
    await (exec as { close?: () => Promise<void> }).close?.();
  }
  return 0;
}

export interface MetaRow {
  spec: string;
  label: string;
  opponent: string[];
  missing: string[];
  winRate: number;
  safestRate: number;
  /** recommended bring: [lead1, lead2, back1, back2] species IDs */
  bring: string[];
  turnOne: string;
  isGuess: boolean;
  battles: number;
}

/** Run the matchup analysis against the regulation's top recorded teams. */
export async function runSimMeta(
  mine: PokemonSet[],
  env: SimEnv,
  opts: { top: number; scale: number; seed: number },
  io: Io,
): Promise<MetaRow[]> {
  if (!env.topTeams || !env.resolveTeam) throw new Error("team database is not available");
  const ctx = simContext(env.pack, env.spec);
  const budget = budgetFrom(env.pack.weights.simulation, opts.scale);
  const rows: MetaRow[] = [];
  for (const spec of env.topTeams(opts.top)) {
    const opp = env.resolveTeam(spec);
    if (!opp || opp.members.length < env.pack.rules.bringCount) {
      io.err(`skip ${spec}: 型を推定できないポケモンがいます`);
      continue;
    }
    const exec = env.executor
      ? env.executor(mine, opp.members)
      : inProcessExecutor(ctx, mine, opp.members);
    try {
      const a = await analyzeMatchup(ctx, mine, opp.members, exec, budget, opts.seed);
      const best = a.equilibrium.mine.indexOf(Math.max(...a.equilibrium.mine));
      const t1 =
        a.turnOne.myOptions[
          a.turnOne.equilibrium.mine.indexOf(Math.max(...a.turnOne.equilibrium.mine))
        ];
      rows.push({
        spec,
        label: opp.label,
        opponent: opp.members.map((m) => m.species),
        missing: opp.missing ?? [],
        winRate: a.equilibrium.value,
        safestRate: a.safest.worstRate,
        bring: a.matrix.mine[best]!,
        turnOne: t1 ? optionStr(t1) : "",
        isGuess: a.turnOne.isGuess,
        battles: a.battles,
      });
      io.err(`… ${opp.label} 完了`);
    } finally {
      await (exec as { close?: () => Promise<void> }).close?.();
    }
  }
  return rows;
}

/**
 * `sim:meta <自分.txt> [--top 10] [--scale 0.3] [--seed 1] [--json]` — run the matchup analysis against
 * the regulation's top recorded teams and summarise the recommended bring per opponent.
 */
export async function simMetaCommand(args: string[], env: SimEnv, io: Io): Promise<number> {
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const mineFile = args.find(
    (x, i) =>
      !x.startsWith("--") &&
      !["--top", "--scale", "--seed", "--workers", "--out"].includes(args[i - 1] ?? ""),
  );
  if (!mineFile || !env.topTeams || !env.resolveTeam) {
    io.err(
      "usage: pnpm sim:meta <自分のパーティ.txt> [--top 10] [--scale 0.3] [--seed 1] [--json]",
    );
    return 2;
  }
  const mine = parseShowdown(env.readText(mineFile), {
    legal: { species: env.pack.legal.species, items: env.pack.legal.items },
  }).members;
  const rows = await runSimMeta(
    mine,
    env,
    {
      top: Number(opt("top") ?? 10),
      scale: Number(opt("scale") ?? 0.3),
      seed: Number(opt("seed") ?? 1),
    },
    io,
  );
  if (args.includes("--json")) {
    io.out(
      JSON.stringify({ regulation: env.pack.id, mine: mine.map((m) => m.species), rows }, null, 2),
    );
    return 0;
  }
  const total = rows.reduce((a, r) => a + r.battles, 0);
  io.out(`上位構築との対戦シミュレーション（合計 ${total}戦、レギュレーション ${env.pack.id}）`);
  io.out(
    "※ 相手の技・特性・性格・SP は使用率データの最多の型による推定です。行動は確率的なAIです（推測を含む）。",
  );
  for (const r of rows) {
    io.out(`■ ${r.label}\n  相手: ${r.opponent.map(name).join("・")}`);
    if (r.missing.length) io.out(`  ※ 型を推定できず除外: ${r.missing.map(name).join("・")}`);
    io.out(`  期待勝率 ${pct(r.winRate)}（安全策の最低勝率 ${pct(r.safestRate)}）`);
    io.out(`  推奨選出: ${names(r.bring)}`);
    if (r.turnOne) io.out(`  1ターン目の基本: ${r.turnOne}${r.isGuess ? "（択あり）" : ""}`);
  }
  return 0;
}
