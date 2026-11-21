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
