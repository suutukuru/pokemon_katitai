// `sim:review` and `sim:tune`: the reflection → improvement loop (ADR-0012).
import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";
import { parseShowdown } from "@ca/ingest";
import {
  allConfigs,
  mixSeed,
  searchBudgetFrom,
  summarizeReviews,
  fitCalibration,
  calibrated,
  tunePolicy,
  TUNABLE,
  type Config,
  type DecisionReview,
  type DuelRunner,
  type OptionSlot,
  type ReplayData,
  type SearchBudget,
  type TuneStep,
} from "@ca/sim";
import type { Io } from "./commands.js";
import type { SimEnv } from "./sim-commands.js";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const name = (id: string) => displayName("species", id);

function slotsText(xs: OptionSlot[] | undefined, fallback: string): string {
  if (!xs) return fallback;
  return xs
    .filter((s) => s.species)
    .map((s) => {
      const who = name(s.species);
      if (s.switchTo) return `${who}→${name(s.switchTo)}に交代`;
      if (s.moveId)
        return `${who}:${s.mega ? "メガ+" : ""}${displayName("moves", s.moveId)}${s.targetSpecies ? `→${name(s.targetSpecies)}` : ""}`;
      if (s.intent)
        return `${who}:${INTENT_JA[s.intent[0]!] ?? s.intent}${s.targetSpecies ? `→${name(s.targetSpecies)}` : ""}`;
      return who;
    })
    .join(" ／ ");
}
const INTENT_JA: Record<string, string> = {
  A: "一番強い攻撃",
  F: "ねこだまし",
  S: "全体攻撃",
  P: "まもる系",
  X: "補助技",
  W: "交代",
};

export interface ReviewDeps {
  /** best-play games (each side plans from its own view) */
  play: (
    tasks: {
      mine: PokemonSet[];
      theirs: PokemonSet[];
      ca: Config;
      cb: Config;
      seed: number;
      budget: SearchBudget;
    }[],
  ) => Promise<ReplayData[]>;
  write?: (path: string, json: unknown) => void;
  writeWeights?: (simulation: Record<string, number>) => void;
}

const opt = (args: string[], k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

/** `sim:review <自分.txt> [--top 4] [--games 2] [--think 0.3] [--seed 1] [--out reports]` */
export async function simReview(
  args: string[],
  env: SimEnv,
  deps: ReviewDeps,
  io: Io,
): Promise<number> {
  const file = args.find((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!file || !env.topTeams || !env.resolveTeam) {
    io.err("usage: pnpm sim:review <自分のパーティ.txt> [--top 4] [--games 2] [--think 0.3]");
    return 2;
  }
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  const mine = parseShowdown(env.readText(file), legal).members;
  const top = Number(opt(args, "top", "4"));
  const games = Number(opt(args, "games", "2"));
  const seed = Number(opt(args, "seed", "1"));
  const budget = searchBudgetFrom(env.pack.weights.simulation, Number(opt(args, "think", "0.3")));
  const bring = env.pack.rules.bringCount;
  const tasks: Parameters<ReviewDeps["play"]>[0] = [];
  const labels: string[] = [];
  for (const spec of env.topTeams(top)) {
    const opp = env.resolveTeam(spec);
    if (!opp || opp.members.length < bring) continue;
    const ca = allConfigs(mine.length, bring);
    const cb = allConfigs(opp.members.length, bring);
    for (let g = 0; g < games; g++) {
      const s = mixSeed(seed, tasks.length);
      tasks.push({
        mine,
        theirs: opp.members,
        ca: ca[s % ca.length]!,
        cb: cb[mixSeed(s, 1) % cb.length]!,
        seed: s,
        budget,
      });
      labels.push(opp.label);
    }
  }
  io.err(`… ${tasks.length}戦（両者が自分から見える情報だけで毎ターン探索）`);
  const datas = await deps.play(tasks);
  const reviews: (DecisionReview & { game: number })[] = datas.flatMap((d, g) =>
    (d.reviews ?? []).map((r) => ({ ...r, game: g })),
  );
  const mineOnly = reviews.filter((r) => r.side === 0);
  const sum = summarizeReviews(mineOnly);
  const all = summarizeReviews(reviews);
  const wins = datas.filter((d) => d.result.winner === 0).length;
  io.out(`振り返り: ${tasks.length}戦（${wins}勝）・自分の判断 ${sum.decisions}回`);
  io.out(
    `  予測の精度: Brier ${sum.brier.toFixed(3)}（0.25 = 当てずっぽう、低いほど良い。両陣営では ${all.brier.toFixed(3)}）`,
  );
  io.out(
    `  相手の実際の行動を候補に入れていた割合 ${pct(1 - sum.surpriseRate)}、その行動に付けていた確率の平均 ${pct(sum.meanPredictedProb)}`,
  );
  io.out(
    `  結果を知った後でも最善だった判断 ${pct(sum.bestReplyRate)}、損失（後から見た最善との勝率差）の平均 ${(sum.meanRegret * 100).toFixed(1)}ポイント`,
  );
  io.out("  予測勝率と実際の勝率:");
  for (const c of sum.calibration)
    if (c.n)
      io.out(
        `    予測 ${pct(c.from)}〜${pct(c.to)}: ${c.n}回、予測平均 ${pct(c.expected)} → 実際 ${pct(c.observed)}`,
      );
  const worst = [...mineOnly]
    .filter((r) => (r.regret ?? 0) > 0)
    .sort((a, b) => (b.regret ?? 0) - (a.regret ?? 0))
    .slice(0, 5);
  if (worst.length) io.out("  後から見て損の大きかった判断:");
  for (const r of worst) {
    io.out(
      `    vs ${labels[r.game]} ${r.turn}ターン目: ${slotsText(r.labels?.chosen, r.chosen)}（相手: ${slotsText(r.labels?.opponent, "?")}）→ ${slotsText(r.labels?.best, r.bestChoice ?? "")} が最善だった（${pct(r.vsActual ?? 0)} → ${pct(r.bestVsActual ?? 0)}）`,
    );
  }
  // calibration of the displayed win rates (only with enough independent games)
  const fit = fitCalibration(reviews);
  io.out(
    `  補正の推定: 予測 p → σ(${fit.a.toFixed(2)}·logit(p) ${fit.b >= 0 ? "+" : "−"} ${Math.abs(fit.b).toFixed(2)})（例 50% → ${pct(calibrated(0.5, { evalCalibA: fit.a, evalCalibB: fit.b }))}、70% → ${pct(calibrated(0.7, { evalCalibA: fit.a, evalCalibB: fit.b }))}）`,
  );
  if (args.includes("--fit")) {
    if (tasks.length >= 30 && deps.writeWeights) {
      deps.writeWeights({
        ...env.pack.weights.simulation,
        evalCalibA: Math.round(fit.a * 1000) / 1000,
        evalCalibB: Math.round(fit.b * 1000) / 1000,
      });
      io.out("  weights.json の evalCalibA / evalCalibB を更新しました（表示する勝率の補正）。");
    } else io.out(`  --fit: 対戦数が足りません（${tasks.length}戦。30戦以上で書き込みます）。`);
  }
  deps.write?.(
    `${opt(args, "out", "reports")}/review-${file.replace(/^.*\//, "").replace(/\.txt$/, "")}.json`,
    {
      summary: sum,
      both: all,
      reviews,
    },
  );
  return 0;
}

export interface TuneDeps {
  run: DuelRunner;
  /** write the accepted weights back to weights.json (only with --write) */
  writeWeights?: (simulation: Record<string, number>) => void;
}

/** `sim:tune [--games 400] [--step 0.3] [--z 2] [--keys a,b] [--top 6] [--seed 1] [--write]` */
export async function simTune(
  args: string[],
  env: SimEnv,
  deps: TuneDeps,
  io: Io,
): Promise<number> {
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  const teams: PokemonSet[][] = [];
  for (const f of opt(args, "teams", "").split(",").filter(Boolean))
    teams.push(parseShowdown(env.readText(f), legal).members);
  for (const spec of env.topTeams?.(Number(opt(args, "top", "6"))) ?? []) {
    const r = env.resolveTeam?.(spec);
    if (r && r.members.length >= env.pack.rules.bringCount) teams.push(r.members);
  }
  if (teams.length < 2) {
    io.err("チームが2つ以上必要です（--teams a.txt,b.txt か上位構築データ）");
    return 1;
  }
  const keys = opt(args, "keys", TUNABLE.join(","))
    .split(",")
    .filter((k) => env.pack.weights.simulation[k] !== undefined);
  const o = {
    games: Number(opt(args, "games", "400")),
    step: Number(opt(args, "step", "0.3")),
    z: Number(opt(args, "z", "2")),
    seed: Number(opt(args, "seed", "1")),
    bring: env.pack.rules.bringCount,
    validate: Number(
      opt(args, "validate", String(Math.max(400, Number(opt(args, "games", "400")) * 2))),
    ),
  };
  io.err(
    `… ${teams.length}チーム、${keys.length}項目 × 最大2方向 × ${o.games}戦（同じ乱数で左右を入れ替えた対局）`,
  );
  const fmt = (s: TuneStep) =>
    `  ${s.key}: ${s.from} → ${s.to}  勝率 ${(s.score * 100).toFixed(1)}% ± ${(s.se * 196).toFixed(1)}（${s.games}戦）${s.accepted ? "  ✓ 採用" : ""}`;
  const res = await tunePolicy(env.pack.weights.simulation, keys, teams, deps.run, o, (s) =>
    io.err(fmt(s)),
  );
  const passed = res.steps.filter((s) => s.accepted);
  io.out(
    `調整: ${res.steps.length}案を試し、${passed.length}件が基準（現行より ${o.z}標準誤差以上 強い）を通過`,
  );
  for (const s of res.steps) io.out(fmt(s));
  const v = res.validation;
  if (v)
    io.out(
      `検証（使っていない乱数で、通過した変更をまとめて元の重みと対戦）: 勝率 ${(v.score * 100).toFixed(1)}% ± ${(v.se * 196).toFixed(1)}（${v.games}戦）→ ${v.accepted ? "採用" : "再現しないので不採用（偶然の勝ちの可能性が高い）"}`,
    );
  const adopted = v?.accepted ? passed : [];
  if (adopted.length && args.includes("--write") && deps.writeWeights) {
    deps.writeWeights(res.params);
    io.out("weights.json に書き込みました（差分を確認してからコミットしてください）。");
  } else if (adopted.length) io.out("--write を付けると weights.json に反映します。");
  else io.out("weights.json は変更しません。");
  return 0;
}
