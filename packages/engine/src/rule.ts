import type { Evidence, Finding, RuleCategory, Severity } from "@ca/schema";
import type { RuleContext } from "./context.js";

export type ParamValue = number | string | boolean;

/** What a rule emits; the engine fills ruleId/version/category/basis/severity. */
export interface FindingDraft {
  explainKey: string;
  score: number;
  params: Record<string, ParamValue>;
  evidence: [Evidence, ...Evidence[]];
  /** Overrides the score→severity mapping (e.g. illegal teams are always critical). */
  severity?: Severity;
  suggestions?: Finding["suggestions"];
}

export interface RuleResult {
  /** 0 (bad) .. 1 (good) for the team score. */
  score: number;
  findings: FindingDraft[];
}

/** Declarative rule (see docs/PLAN.md §5). Weights and thresholds live in weights.json. */
export interface Rule {
  id: string;
  version: number;
  category: RuleCategory;
  /** Parameter names this rule reads from weights.params[id]. Checked before running. */
  params: readonly string[];
  appliesTo(ctx: RuleContext): boolean;
  evaluate(ctx: RuleContext): RuleResult;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Comma-joined ID list for template params (explain renders each with displayName). */
export const ids = (xs: readonly string[]) => [...xs].join(",");
