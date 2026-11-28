import {
  BattleRecordSchema,
  TeacherDatasetSchema,
  type PokemonSet,
  type TeacherDataset,
  type TeacherPosition,
} from "@ca/schema";
import { parseShowdown } from "@ca/ingest";
import type { TeacherTask } from "@ca/sim/pool";
import {
  allConfigs,
  compareTeacherEvals,
  evaluateAgainstTeacher,
  mixSeed,
  searchOptionsFrom,
  type TeacherEval,
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

export interface TeacherEnv extends EvalEnv {
  runTeacher: (tasks: TeacherTask[], onDone: (i: number) => void) => Promise<TeacherPosition[][]>;
  writeText: (path: string, text: string) => void;
}

const TEACHER_DEFAULT_TEAMS = [
  "packages/data/teams/samples/user-team-1.txt",
  "packages/data/teams/samples/sample-rain.txt",
  "packages/data/teams/samples/sample-trickroom.txt",
];

/**
 * `sim:teacher build [--teams a.txt,b.txt,..] [--battles 2] [--scale 1] [--seed 1] [--out f.json]`
 * `sim:teacher eval <f.json> [--json] [--baseline 前回.json]`
 */
export async function simTeacherCommand(args: string[], env: TeacherEnv, io: Io): Promise<number> {
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const ctx = simContext(env.pack, env.spec);
  const temperature = ctx.params["temperature"];
  if (temperature === undefined) throw new Error("weights.simulation.temperature is missing");
  const sub = args[0];
  if (sub === "build") {
    const files = (opt("teams") ?? TEACHER_DEFAULT_TEAMS.join(",")).split(",");
    const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
    const teams: Record<string, PokemonSet[]> = {};
    for (const f of files) {
      const key = f.replace(/^.*\//, "").replace(/\.txt$/, "");
      teams[key] = parseShowdown(env.readText(f), legal).members;
    }
    const keys = Object.keys(teams).sort();
    const battles = Number(opt("battles") ?? 2);
    const scale = Number(opt("scale") ?? 1);
    const seed = Number(opt("seed") ?? 1);
    const opts = searchOptionsFrom(ctx.params, scale);
    const kinds = (opt("kinds") ?? "move")
      .split(",")
      .filter((k): k is "move" | "switch" => k === "move" || k === "switch");
    const tasks: TeacherTask[] = [];
    keys.forEach((ka, i) =>
      keys.forEach((kb, j) => {
        if (i === j) return;
        const ca = allConfigs(teams[ka]!.length, env.pack.rules.bringCount);
        const cb = allConfigs(teams[kb]!.length, env.pack.rules.bringCount);
        for (let k = 0; k < battles; k++) {
          const s = mixSeed(seed, i, j, k);
          tasks.push({
            teams: [ka, kb],
            a: teams[ka]!,
            b: teams[kb]!,
            configs: [ca[s % ca.length]!, cb[(s >>> 8) % cb.length]!],
            seed: s,
            opts,
            kinds,
          });
        }
      }),
    );
    io.err(`… ${tasks.length}戦を探索でラベル付け（search scale ${scale}）`);
    let done = 0;
    const res = await env.runTeacher(tasks, () => io.err(`  ${++done}/${tasks.length}`));
    const data: TeacherDataset = {
      regulationId: env.pack.id,
      generator: {
        searchWidth: opts.options,
        stages: opts.stages.map((s) => `${s.rollouts}/${s.keep}`).join(" "),
        battles: tasks.length,
        kinds: kinds.join(","),
        seed,
        temperature,
      },
      teams,
      positions: res.flat(),
    };
    const out = opt("out") ?? "docs/sim-eval/teacher-positions.json";
    env.writeText(out, JSON.stringify(data) + "\n");
    io.out(`${data.positions.length}局面を ${out} に書きました`);
    return 0;
  }
  if (sub === "eval" && args[1]) {
    const data = TeacherDatasetSchema.parse(JSON.parse(env.readText(args[1])));
    // `--half even|odd`: every other position, to check a change holds on both halves
    const half = opt("half");
    if (half === "even" || half === "odd")
      data.positions = data.positions.filter((_, i) => i % 2 === (half === "even" ? 0 : 1));
    // `--set key=value` (repeatable): try other weights.simulation values without editing the pack
    const params = { ...ctx.params };
    args.forEach((x, i) => {
      if (x !== "--set") return;
      const [k, v] = (args[i + 1] ?? "").split("=");
      if (!k || v === undefined || !Number.isFinite(Number(v)) || params[k] === undefined)
        throw new Error(`--set ${args[i + 1] ?? ""}: unknown weights.simulation key or bad number`);
      params[k] = Number(v);
    });
    const ev = evaluateAgainstTeacher(
      { ...ctx, params },
      data,
      params["temperature"] ?? temperature,
    );
    const base = opt("baseline");
    const diff = base
      ? compareTeacherEvals(JSON.parse(env.readText(base)) as TeacherEval, ev)
      : undefined;
    if (args.includes("--json")) io.out(JSON.stringify(diff ? { ...ev, diff } : ev, null, 2));
    else {
      io.out(`方針と探索（先生役）の比較（${ev.positions}局面、温度 ${ev.temperature}）`);
      io.out(row("1匹ごと", ev.rates.slot));
      io.out(row("2匹まとめて", ev.rates.joint));
      for (const [k, t] of Object.entries(ev.rates.byCategory))
        if (t.n) io.out(row(CATEGORY_JA[k] ?? k, t));
      if (ev.forcedSwitch.n)
        io.out(
          `  倒れた後などの交代 ${ev.forcedSwitch.n}件: 探索と一致 ${pct(ev.forcedSwitch.top1)} / 方針の選択の勝率 ${pct(ev.forcedSwitch.meanPolicyRate)}（探索の最善 ${pct(ev.forcedSwitch.meanBestRate)}）`,
        );
      io.out(
        `  探索の最善手の勝率 ${pct(ev.meanBestRate)} / 方針の期待勝率 ${pct(ev.meanPolicyRate)}（失う勝率 ${pct(ev.meanRegret)}、探索が評価した候補に乗った確率 ${pct(ev.coverage)}）`,
      );
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
  io.err(
    "usage: pnpm sim:teacher build [--teams a.txt,b.txt] [--battles 2] [--scale 1] [--out f.json]",
  );
  io.err(
    "       pnpm sim:teacher eval <f.json> [--json] [--baseline 前回.json] [--set key=value ...] [--half even|odd]",
  );
  return 2;
}
