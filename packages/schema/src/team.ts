import { z } from "zod";
import { StatsTableSchema } from "./common.js";
import { IdSchema } from "./id.js";

/** Per-field extraction confidence (0..1). Fields absent from the map were entered by hand (1.0). */
export const ConfidenceMapSchema = z.record(z.string(), z.number().min(0).max(1)).default({});

export const NatureSchema = z.enum([
  "Hardy",
  "Lonely",
  "Brave",
  "Adamant",
  "Naughty",
  "Bold",
  "Docile",
  "Relaxed",
  "Impish",
  "Lax",
  "Timid",
  "Hasty",
  "Serious",
  "Jolly",
  "Naive",
  "Modest",
  "Mild",
  "Quiet",
  "Bashful",
  "Rash",
  "Calm",
  "Gentle",
  "Sassy",
  "Careful",
  "Quirky",
]);

export const PokemonSetSchema = z.object({
  species: IdSchema,
  nickname: z.string().optional(),
  item: IdSchema.optional(),
  ability: IdSchema,
  nature: NatureSchema,
  sp: StatsTableSchema,
  moves: z.array(IdSchema).min(1).max(4),
  gender: z.enum(["M", "F", "N"]).optional(),
  confidence: ConfidenceMapSchema,
  /** Fields filled from the most-used set because they could not be read. Shown in UI. */
  assumed: z.array(z.string()).default([]),
});
export type PokemonSet = z.infer<typeof PokemonSetSchema>;

export const TeamSchema = z.object({
  name: z.string().optional(),
  regulationId: z.string(),
  members: z.array(PokemonSetSchema).min(1).max(6),
});
export type Team = z.infer<typeof TeamSchema>;
