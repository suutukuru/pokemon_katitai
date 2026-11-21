import { z } from "zod";

export const LocalizedTextSchema = z
  .object({ ja: z.string().min(1), en: z.string().min(1) })
  .catchall(z.string());
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

export const SourceSchema = z.object({
  title: z.string().min(1),
  url: z.url().optional(),
  accessed: z.iso.date().optional(),
  note: z.string().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

/** Every hand-entered game fact carries whether it has been confirmed against multiple sources. */
export const VerificationSchema = z.object({
  verified: z.boolean(),
  sources: z.array(SourceSchema).default([]),
});

export const StatIdSchema = z.enum(["hp", "atk", "def", "spa", "spd", "spe"]);
export type StatId = z.infer<typeof StatIdSchema>;
export const STAT_IDS = StatIdSchema.options;

export const StatsTableSchema = z.object({
  hp: z.number().int().nonnegative(),
  atk: z.number().int().nonnegative(),
  def: z.number().int().nonnegative(),
  spa: z.number().int().nonnegative(),
  spd: z.number().int().nonnegative(),
  spe: z.number().int().nonnegative(),
});
export type StatsTable = z.infer<typeof StatsTableSchema>;

export const PokemonTypeSchema = z.enum([
  "Normal",
  "Fire",
  "Water",
  "Electric",
  "Grass",
  "Ice",
  "Fighting",
  "Poison",
  "Ground",
  "Flying",
  "Psychic",
  "Bug",
  "Rock",
  "Ghost",
  "Dragon",
  "Dark",
  "Steel",
  "Fairy",
  "Stellar",
]);
export type PokemonType = z.infer<typeof PokemonTypeSchema>;
