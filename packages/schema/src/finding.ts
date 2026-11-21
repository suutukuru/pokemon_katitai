import { z } from "zod";
import { SourceSchema } from "./common.js";
import { PackIdSchema } from "./id.js";

/**
 * Evidence kinds are distinguished at the type level:
 * - calc: deterministic engine output (damage, speed order, probability)
 * - data: a fact from a dataset (usage snapshot, team DB) with provenance
 * - heuristic: an estimate (e.g. opponent lead tendency). Never presented as computed.
 */
export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("calc"),
    label: z.string(),
    /** Structured values the explain layer may quote. LLM output may only use these numbers. */
    values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    formula: z.string().optional(),
  }),
  z.object({
    kind: z.literal("data"),
    label: z.string(),
    values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    source: SourceSchema,
    snapshot: z.string().optional(),
  }),
  z.object({
    kind: z.literal("heuristic"),
    label: z.string(),
    values: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
    rationale: z.string(),
  }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SeveritySchema = z.enum(["critical", "major", "minor", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

export const RuleCategorySchema = z.enum([
  "speedControl",
  "support",
  "defensiveSynergy",
  "offense",
  "matchup",
  "itemAbility",
  "selection",
  "mega",
  "field",
  "legality",
]);
export type RuleCategory = z.infer<typeof RuleCategorySchema>;

export const SuggestionSchema = z.object({
  explainKey: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  /** Suggestions must be verified by re-running the calc; the before/after is the evidence. */
  evidence: z.array(EvidenceSchema).min(1),
});

export const FindingSchema = z.object({
  ruleId: z.string(),
  ruleVersion: z.number().int().positive(),
  category: RuleCategorySchema,
  severity: SeveritySchema,
  /** "computed" only if every evidence item is calc/data. */
  basis: z.enum(["computed", "estimated"]),
  score: z.number().min(0).max(1),
  explainKey: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  evidence: z.array(EvidenceSchema).min(1, "A Finding must have at least one evidence item"),
  suggestions: z.array(SuggestionSchema).default([]),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Attached to every analysis result so it can be reproduced under the same rules/data. */
export const AnalysisMetaSchema = z.object({
  regulationId: PackIdSchema,
  regulationChain: z.array(PackIdSchema),
  dataVersion: z.string(),
  contentHash: z.string(),
  usageSnapshot: z.string().optional(),
  engineVersion: z.string(),
  seed: z.number().int().optional(),
  createdAt: z.iso.datetime(),
});
export type AnalysisMeta = z.infer<typeof AnalysisMetaSchema>;
