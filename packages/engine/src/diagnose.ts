import {
  AnalysisMetaSchema,
  FindingSchema,
  SEVERITY_ORDER,
  type AnalysisMeta,
  type Finding,
  type GameSpec,
  type PokemonSet,
  type ResolvedPack,
  type Severity,
  type StatsTable,
  type UsageSnapshot,
} from "@ca/schema";
import { canonicalJson } from "@ca/data";
import { RuleContext } from "./context.js";
import type { Rule } from "./rule.js";
import { RULES } from "./rules/index.js";

export const ENGINE_VERSION = "0.3.0";

export interface RuleScore {
  ruleId: string;
  version: number;
  weight: number;
  score: number;
  applied: boolean;
}

export interface DiagnosisReport {
  meta: AnalysisMeta;
  /** 0..100: Σ(weight × score) / Σ weight over applied rules. */
  score: number;
  ruleScores: RuleScore[];
  /** Sorted by severity, then rule order, then explainKey. */
  findings: Finding[];
  members: {
    species: string;
    forme: string;
    mega: boolean;
    stats: StatsTable;
    assumed: string[];
  }[];
}

export interface DiagnoseOptions {
  usage?: UsageSnapshot;
  rules?: readonly Rule[];
  /** Fixed timestamp for reproducible output (tests, snapshots). */
  now?: Date;
}

function severityOf(score: number, pack: ResolvedPack): Severity {
  const t = pack.weights.severity;
  if (!t) throw new Error(`weights.severity is missing in ${pack.id}`);
  if (score < t.critical) return "critical";
  if (score < t.major) return "major";
  if (score < t.minor) return "minor";
  return "info";
}

/** Run every applicable rule and return evidence-backed findings, most severe first. Deterministic. */
export function diagnose(
  team: readonly PokemonSet[],
  pack: ResolvedPack,
  spec: GameSpec,
  options: DiagnoseOptions = {},
): DiagnosisReport {
  const ctx = new RuleContext(team, pack, spec, options.usage);
  const rules = options.rules ?? RULES;
  const findings: Finding[] = [];
  const ruleScores: RuleScore[] = [];
  rules.forEach((rule) => {
    for (const p of rule.params) ctx.param(rule.id, p); // fail fast on missing params
    const weight = pack.weights.rules[rule.id] ?? 0;
    if (!rule.appliesTo(ctx)) {
      ruleScores.push({ ruleId: rule.id, version: rule.version, weight, score: 1, applied: false });
      return;
    }
    const r = rule.evaluate(ctx);
    ruleScores.push({
      ruleId: rule.id,
      version: rule.version,
      weight,
      score: r.score,
      applied: true,
    });
    for (const d of r.findings) {
      const basis = d.evidence.every((e) => e.kind !== "heuristic") ? "computed" : "estimated";
      findings.push(
        FindingSchema.parse({
          ruleId: rule.id,
          ruleVersion: rule.version,
          category: rule.category,
          severity: d.severity ?? severityOf(d.score, pack),
          basis,
          score: Math.round(d.score * 1000) / 1000,
          explainKey: d.explainKey,
          params: d.params,
          evidence: d.evidence,
          suggestions: d.suggestions ?? [],
        }),
      );
    }
  });
  const order = new Map(rules.map((r, i) => [r.id, i]));
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      order.get(a.ruleId)! - order.get(b.ruleId)! ||
      a.explainKey.localeCompare(b.explainKey) ||
      canonicalJson(a.params).localeCompare(canonicalJson(b.params)),
  );
  const applied = ruleScores.filter((r) => r.applied && r.weight > 0);
  const totalW = applied.reduce((a, r) => a + r.weight, 0);
  const score = totalW
    ? Math.round((applied.reduce((a, r) => a + r.weight * r.score, 0) / totalW) * 1000) / 10
    : 0;
  const meta = AnalysisMetaSchema.parse({
    regulationId: pack.id,
    regulationChain: pack.chain,
    dataVersion: pack.dataVersion,
    contentHash: pack.contentHash,
    ...(options.usage
      ? { usageSnapshot: `${options.usage.regulationId}@${options.usage.date}` }
      : {}),
    engineVersion: ENGINE_VERSION,
    createdAt: (options.now ?? new Date()).toISOString(),
  });
  const members = team.map((m) => {
    const mega = ctx.canMega(m);
    return {
      species: m.species,
      forme: ctx.formeInBattle(m),
      mega,
      stats: ctx.stats(m, mega),
      assumed: m.assumed,
    };
  });
  return { meta, score, ruleScores, findings, members };
}
