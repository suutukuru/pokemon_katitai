import { z } from "zod";
import {
  LocalizedTextSchema,
  PokemonTypeSchema,
  SourceSchema,
  StatsTableSchema,
} from "./common.js";
import { IdSchema, PackIdSchema } from "./id.js";

// ---------- manifest.json ----------

export const PeriodSchema = z
  .object({ start: z.iso.date(), end: z.iso.date().optional() })
  .refine((p) => p.end === undefined || p.start <= p.end, {
    message: "period.end must be >= start",
  });

export const SetDeltaSchema = z.object({
  add: z.array(IdSchema).default([]),
  remove: z.array(IdSchema).default([]),
});
export type SetDelta = z.infer<typeof SetDeltaSchema>;

export const MechanicIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9-]*$/);

export const ManifestSchema = z.strictObject({
  $schema: z.string().optional(),
  id: PackIdSchema,
  name: LocalizedTextSchema,
  extends: PackIdSchema.optional(),
  periods: z
    .strictObject({ ranked: PeriodSchema.optional(), official: PeriodSchema.optional() })
    .default({}),
  /** Mechanic plugin IDs, as a delta against the parent (root: `add` is the full list). */
  mechanics: z
    .strictObject({
      add: z.array(MechanicIdSchema).default([]),
      remove: z.array(MechanicIdSchema).default([]),
    })
    .default({ add: [], remove: [] }),
  dataVersion: z.string().min(1),
  verified: z.boolean(),
  sources: z.array(SourceSchema).default([]),
  notes: z.string().optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ---------- legal.json ----------

export const LegalDeltaSchema = z.strictObject({
  $schema: z.string().optional(),
  verified: z.boolean().default(false),
  species: SetDeltaSchema.default({ add: [], remove: [] }),
  /** Species (base form IDs) allowed to Mega Evolve. */
  megaSpecies: SetDeltaSchema.default({ add: [], remove: [] }),
  items: SetDeltaSchema.default({ add: [], remove: [] }),
  bannedMoves: SetDeltaSchema.default({ add: [], remove: [] }),
  bannedAbilities: SetDeltaSchema.default({ add: [], remove: [] }),
});
export type LegalDelta = z.infer<typeof LegalDeltaSchema>;

// ---------- overrides.json ----------

const OverrideMeta = {
  verified: z.boolean(),
  sources: z.array(SourceSchema).default([]),
  note: z.string().optional(),
};

export const SpeciesOverrideSchema = z.strictObject({
  ...OverrideMeta,
  baseStats: StatsTableSchema.partial().optional(),
  types: z.array(PokemonTypeSchema).min(1).max(2).optional(),
  abilities: z.array(IdSchema).min(1).optional(),
});
export const NewSpeciesSchema = z.strictObject({
  ...OverrideMeta,
  name: z.string().min(1),
  baseSpecies: IdSchema.optional(),
  baseStats: StatsTableSchema,
  types: z.array(PokemonTypeSchema).min(1).max(2),
  abilities: z.array(IdSchema).min(1),
  weightkg: z.number().positive(),
});
export const MoveOverrideSchema = z.strictObject({
  ...OverrideMeta,
  basePower: z.number().int().nonnegative().optional(),
  accuracy: z.union([z.number().int().min(1).max(100), z.literal(true)]).optional(),
  pp: z.number().int().positive().optional(),
  priority: z.number().int().min(-7).max(5).optional(),
  type: PokemonTypeSchema.optional(),
  category: z.enum(["Physical", "Special", "Status"]).optional(),
  secondaryChance: z.number().int().min(0).max(100).optional(),
});
export const EffectOverrideSchema = z.strictObject({
  ...OverrideMeta,
  /** Free-form parameters consumed by a named Mechanic/adapter hook. */
  params: z.record(z.string(), z.unknown()).default({}),
});

/** A value of `null` removes the parent's override for that ID. */
const nullable = <T extends z.ZodType>(s: T) => z.record(IdSchema, s.nullable()).default({});

export const OverridesDeltaSchema = z.strictObject({
  $schema: z.string().optional(),
  species: nullable(SpeciesOverrideSchema),
  newSpecies: nullable(NewSpeciesSchema),
  moves: nullable(MoveOverrideSchema),
  abilities: nullable(EffectOverrideSchema),
  items: nullable(EffectOverrideSchema),
});
export type OverridesDelta = z.infer<typeof OverridesDeltaSchema>;

// ---------- rules.json ----------

export const RulesSchema = z.strictObject({
  format: z.enum(["doubles", "singles"]),
  level: z.number().int().min(1).max(100),
  teamSize: z.number().int().min(1).max(6),
  bringCount: z.number().int().min(1).max(6),
  activeCount: z.number().int().min(1).max(3),
  speciesClause: z.boolean(),
  itemClause: z.boolean(),
  megaPerBattle: z.number().int().nonnegative(),
  timers: z
    .strictObject({
      verified: z.boolean(),
      totalSeconds: z.number().int().positive().optional(),
      playerSeconds: z.number().int().positive().optional(),
      turnSeconds: z.number().int().positive().optional(),
      selectionSeconds: z.number().int().positive().optional(),
    })
    .optional(),
  verified: z.boolean(),
});
export type Rules = z.infer<typeof RulesSchema>;
/** Child packs specify only what changes. */
export const RulesDeltaSchema = RulesSchema.partial().extend({ $schema: z.string().optional() });

// ---------- weights.json ----------

export const WeightsSchema = z.strictObject({
  version: z.string().min(1),
  origin: z.enum(["manual", "learned"]),
  rules: z.record(z.string(), z.number()).default({}),
  evaluation: z.record(z.string(), z.number()).default({}),
  search: z
    .strictObject({
      depth: z.number().int().min(1).max(5).optional(),
      beamWidth: z.number().int().positive().optional(),
      opponentTopK: z.number().int().positive().optional(),
    })
    .default({}),
});
export type Weights = z.infer<typeof WeightsSchema>;
export const WeightsDeltaSchema = WeightsSchema.partial().extend({
  $schema: z.string().optional(),
});

// ---------- resolved ----------

export const ResolvedPackSchema = z.object({
  id: PackIdSchema,
  name: LocalizedTextSchema,
  chain: z.array(PackIdSchema).min(1),
  dataVersion: z.string(),
  contentHash: z.string(),
  verified: z.boolean(),
  periods: z.object({ ranked: PeriodSchema.optional(), official: PeriodSchema.optional() }),
  mechanics: z.array(MechanicIdSchema),
  sources: z.array(SourceSchema),
  legal: z.object({
    verified: z.boolean(),
    species: z.array(z.string()),
    megaSpecies: z.array(z.string()),
    items: z.array(z.string()),
    bannedMoves: z.array(z.string()),
    bannedAbilities: z.array(z.string()),
  }),
  overrides: z.object({
    species: z.record(z.string(), SpeciesOverrideSchema),
    newSpecies: z.record(z.string(), NewSpeciesSchema),
    moves: z.record(z.string(), MoveOverrideSchema),
    abilities: z.record(z.string(), EffectOverrideSchema),
    items: z.record(z.string(), EffectOverrideSchema),
  }),
  rules: RulesSchema,
  weights: WeightsSchema,
});
export type ResolvedPack = z.infer<typeof ResolvedPackSchema>;
