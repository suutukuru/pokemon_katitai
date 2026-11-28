import { BattleRecordSchema } from "@ca/schema";
import {
  analyzeMatchup,
  budgetFrom,
  compareSummaries,
  evaluateActions,
  inProcessExecutor,
  resolveRecord,
  selectionRanks,
  simContext,
  summarize,
  type EvalSummary,
  type RecordEval,
  type TallyRates,
} from "@ca/sim";
import type { Io } from "./commands.js";
import type { SimEnv } from "./sim-commands.js";

export interface EvalEnv extends SimEnv {
  /** Record files: the path itself, or every *.json inside a directory (sorted). */
  listRecordFiles: (path: string) => string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const CATEGORY_JA: Record<string, string> = {
  protect: "守る",
  fakeout: "ねこだまし",
  switch: "交代",
  focus: "集中攻撃",
  speedControl: "素早さ操作",
  attack: "攻撃（その他）",
  other: "変化技（その他）",
};
const row = (label: string, t: TallyRates) =>
  `  ${label.padEnd(10, "　")} ${String(t.n).padStart(5)}件  1位一致 ${pct(t.top1).padStart(6)}  上位3 ${pct(t.top3).padStart(6)}  平均対数確率 ${t.meanLogProb.toFixed(3)}`;

/** Render the evaluation summary in Japanese. Every number comes from the summary. */
export function formatEval(s: EvalSummary): string[] {
  const out: string[] = [];
  out.push(
    `方針の検証（レギュレーション ${s.regulationId}、記録 ${s.records}件、温度 ${s.temperature}）`,
  );
  out.push("■ 行動（方針が付けた確率と実際の行動の比較）");
  out.push(row("1匹ごと", s.rates.slot));
  out.push(row("2匹まとめて", s.rates.joint));
  out.push("■ 実際の行動の種類ごと（1匹ごと。集中攻撃は2匹まとめて）");
  for (const [k, t] of Object.entries(s.rates.byCategory))
    if (t.n) out.push(row(CATEGORY_JA[k] ?? k, t));
  out.push(
    `  選択肢に無かった行動 ${s.actions.unmatched}件 / 観測できなかった行動 ${s.actions.unknown}件`,
  );
  if (s.selection.n) {
    const x = s.selection;
    out.push(`■ 選出（${x.n}件。予備戦の勝率順で何位か）`);
    out.push(`  4匹: 1位 ${pct(x.fourTop1)} / 上位3 ${pct(x.fourTop3)} / 平均 ${x.meanFourRank}位`);
    out.push(`  4匹＋先発: 上位3 ${pct(x.configTop3)} / 平均 ${x.meanConfigRank}位`);
    out.push(`  先発（その4匹の中で）: 1位 ${pct(x.leadTop1)} / 平均 ${x.meanLeadRank}位`);
  }
  for (const r of s.perRecord)
    if (r.divergence || r.turnsEvaluated < r.turnsTotal)
      out.push(
        `  [${r.id}] ${r.turnsEvaluated}/${r.turnsTotal}ターンで打ち切り: ${r.divergence ?? ""}`,
      );
  return out;
}

/**
 * `sim:eval <記録.json | ディレクトリ> [--json] [--no-selection] [--scale 0.25] [--seed 1]
 *   [--baseline 前回.json]`
 */
export async function simEvalCommand(args: string[], env: EvalEnv, io: Io): Promise<number> {
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const valued = ["--scale", "--seed", "--baseline", "--workers"];
  const target = args.find((x, i) => !x.startsWith("--") && !valued.includes(args[i - 1] ?? ""));
  if (!target) {
    io.err(
      "usage: pnpm sim:eval <記録.json | ディレクトリ> [--json] [--no-selection] [--scale 0.25] [--seed 1] [--baseline 前回.json]",
    );
    return 2;
  }
  const ctx = simContext(env.pack, env.spec);
  const temperature = ctx.params["temperature"];
  if (temperature === undefined) throw new Error("weights.simulation.temperature is missing");
  const legal = { species: env.pack.legal.species, items: env.pack.legal.items };
  const doSelection = !args.includes("--no-selection");
  const scale = Number(opt("scale") ?? 0.25);
  const seed = Number(opt("seed") ?? 1);
  const perRecord: RecordEval[] = [];
  for (const file of env.listRecordFiles(target)) {
    const parsed = BattleRecordSchema.safeParse(JSON.parse(env.readText(file)));
    if (!parsed.success) {
      io.err(`[${file}] 記録の形式が正しくありません: ${parsed.error.issues[0]?.message ?? ""}`);
      return 1;
    }
    if (parsed.data.regulationId !== env.pack.id)
      io.err(
        `[${file}] レギュレーション ${parsed.data.regulationId} の記録を ${env.pack.id} で評価します`,
      );
    const { record, teams, issues } = resolveRecord(parsed.data, legal);
    for (const x of issues) io.err(`[${file}] ${x}`);
    const actions = evaluateActions(ctx, record, teams, temperature);
    let selection: RecordEval["selection"] = [];
    const bring = env.pack.rules.bringCount;
    if (doSelection && teams.every((t) => t.length > bring)) {
      io.err(`… [${record.id}] 選出の推奨を計算中`);
      const exec = env.executor
        ? env.executor(teams[0], teams[1])
        : inProcessExecutor(ctx, teams[0], teams[1]);
      try {
        const a = await analyzeMatchup(
          ctx,
          teams[0],
          teams[1],
          exec,
          budgetFrom(ctx.params, scale),
          seed,
        );
        selection = selectionRanks(a, record, teams);
      } finally {
        await (exec as { close?: () => Promise<void> }).close?.();
      }
    }
    perRecord.push({ ...actions, selection });
  }
  const summary = summarize(env.pack.id, temperature, perRecord);
  const base = opt("baseline");
  const diff = base
    ? compareSummaries(JSON.parse(env.readText(base)) as EvalSummary, summary)
    : undefined;
  if (args.includes("--json"))
    io.out(JSON.stringify(diff ? { ...summary, diff } : summary, null, 2));
  else {
    for (const l of formatEval(summary)) io.out(l);
    if (diff) {
      io.out(`■ 基準値（${base}）との比較（後 − 前）`);
      for (const d of diff)
        io.out(
          `  ${d.metric.padEnd(28)} ${d.before.toFixed(4)} → ${d.after.toFixed(4)}  (${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(4)})`,
        );
    }
  }
  return 0;
}
