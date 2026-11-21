import { z } from "zod";
import { PokemonTypeSchema, SourceSchema, StatsTableSchema } from "./common.js";
import { NatureSchema } from "./team.js";

/** Classification of moves/abilities used by the rule engine (data, not code). */
export const EngineTagsSchema = z.object({
  verified: z.boolean(),
  sources: z.array(SourceSchema),
  note: z.string().optional(),
  moves: z.object({
    /** move ID → kind of speed control */
    speedControl: z.record(z.string(), z.enum(["tailwind", "trickroom", "speedDrop", "paralysis"])),
    fakeOut: z.array(z.string()),
    redirection: z.array(z.string()),
    protect: z.array(z.string()),
    teamProtect: z.array(z.string()),
    disruption: z.array(z.string()),
    screens: z.array(z.string()),
    pivot: z.array(z.string()),
    sleep: z.array(z.string()),
    turnOrder: z.array(z.string()),
    weather: z.record(z.string(), z.enum(["Sun", "Rain", "Sand", "Snow"])),
    terrain: z.record(z.string(), z.enum(["Electric", "Grassy", "Psychic", "Misty"])),
  }),
  abilities: z.object({
    intimidate: z.array(z.string()),
    weather: z.record(z.string(), z.enum(["Sun", "Rain", "Sand", "Snow"])),
    terrain: z.record(z.string(), z.enum(["Electric", "Grassy", "Psychic", "Misty"])),
    /** ability → attacking type it makes the holder immune to */
    typeImmunity: z.record(z.string(), PokemonTypeSchema),
    redirection: z.record(z.string(), PokemonTypeSchema),
    priorityBlock: z.array(z.string()),
    prankster: z.array(z.string()),
    /** -ate abilities: moves of type `from` become type `to` */
    typeChange: z
      .record(z.string(), z.object({ from: PokemonTypeSchema, to: PokemonTypeSchema }))
      .default({}),
    /** ability → condition under which Speed is doubled */
    speedDouble: z.record(z.string(), z.string()),
  }),
});
export type EngineTags = z.infer<typeof EngineTagsSchema>;

/** Dated usage snapshot for a regulation (manually imported; see docs/OPEN_QUESTIONS D-01). */
export const UsageSnapshotSchema = z.object({
  regulationId: z.string(),
  date: z.iso.date(),
  format: z.enum(["doubles", "singles"]),
  source: SourceSchema,
  /** true for hand-made fixtures that are not real usage data */
  sample: z.boolean().default(false),
  entries: z
    .array(
      z.object({
        species: z.string(),
        usage: z.number().min(0).max(1),
        /** Most common sets, share 0..1 within the species. */
        sets: z
          .array(
            z.object({
              share: z.number().min(0).max(1),
              item: z.string().optional(),
              ability: z.string(),
              nature: NatureSchema,
              sp: StatsTableSchema,
              moves: z.array(z.string()).min(1).max(4),
              mega: z.boolean().default(false),
            }),
          )
          .default([]),
      }),
    )
    .min(1),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
