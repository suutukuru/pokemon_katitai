import { z } from "zod";
import { SourceSchema } from "./common.js";

/** ID → localized names. Keys are Showdown IDs (`toID`). */
const NameTable = z.record(z.string(), z.object({ ja: z.string().optional(), en: z.string() }));

export const I18nNamesSchema = z.object({
  version: z.string(),
  sources: z.array(SourceSchema),
  species: NameTable,
  moves: NameTable,
  abilities: NameTable,
  items: NameTable,
  natures: NameTable,
  types: NameTable,
});
export type I18nNames = z.infer<typeof I18nNamesSchema>;
export type NameKind = Exclude<keyof I18nNames, "version" | "sources">;
export const NAME_KINDS: readonly NameKind[] = [
  "species",
  "moves",
  "abilities",
  "items",
  "natures",
  "types",
];

/** Mainline move metadata that @smogon/calc does not carry (accuracy, secondary chance, target). */
export const MoveMetaSchema = z.object({
  version: z.string(),
  sources: z.array(SourceSchema),
  moves: z.record(
    z.string(),
    z.object({
      /** null = cannot miss */
      accuracy: z.number().int().min(1).max(100).nullable(),
      pp: z.number().int().positive().nullable(),
      priority: z.number().int(),
      target: z.string(),
      /** Chance (%) of the secondary effect, null if none. */
      effectChance: z.number().int().min(0).max(100).nullable(),
    }),
  ),
});
export type MoveMeta = z.infer<typeof MoveMetaSchema>;
