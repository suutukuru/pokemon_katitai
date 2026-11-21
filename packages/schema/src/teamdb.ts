import { z } from "zod";
import { SourceSchema, StatsTableSchema } from "./common.js";
import { NatureSchema } from "./team.js";

/** One member of a recorded team. Fields that were not published are simply absent. */
export const TeamRecordMemberSchema = z.object({
  species: z.string(),
  item: z.string().optional(),
  ability: z.string().optional(),
  nature: NatureSchema.optional(),
  sp: StatsTableSchema.optional(),
  moves: z.array(z.string()).max(4).optional(),
});

export const TeamRecordSchema = z.object({
  id: z.string(),
  season: z.string(),
  format: z.enum(["doubles", "singles"]),
  rank: z.number().int().positive().optional(),
  rating: z.number().optional(),
  event: z.string().optional(),
  date: z.iso.date().optional(),
  members: z.array(TeamRecordMemberSchema).min(1).max(6),
  /** Which fields are known for this team (open data has species + items only). */
  published: z.object({
    items: z.boolean(),
    moves: z.boolean(),
    sp: z.boolean(),
    abilities: z.boolean(),
  }),
  /** Lead pairs with observed frequency, if known (e.g. from replays). */
  leads: z
    .array(
      z.object({ pair: z.tuple([z.string(), z.string()]), count: z.number().int().nonnegative() }),
    )
    .default([]),
  source: SourceSchema,
});
export type TeamRecord = z.infer<typeof TeamRecordSchema>;

export const TeamDatabaseFileSchema = z.object({
  /** e.g. "pokedb-opendata" */
  dataset: z.string(),
  season: z.string(),
  format: z.enum(["doubles", "singles"]),
  updatedAt: z.string(),
  source: SourceSchema,
  license: z.string(),
  teams: z.array(TeamRecordSchema),
});
export type TeamDatabaseFile = z.infer<typeof TeamDatabaseFileSchema>;
