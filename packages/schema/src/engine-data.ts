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
const Share = z.object({ id: z.string(), share: z.number().min(0).max(1) });

export const UsageSnapshotSchema = z.object({
  regulationId: z.string(),
  date: z.iso.date(),
  format: z.enum(["doubles", "singles"]),
  source: SourceSchema,
  /** true for hand-made fixtures that are not real usage data */
  sample: z.boolean().default(false),
  /** e.g. number of battles and rating cutoff of the underlying stats */
  battles: z.number().nonnegative().optional(),
  cutoff: z.number().optional(),
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
        /** Marginal distributions (share of this species' teams). */
        distributions: z
          .object({
            moves: z.array(Share),
            items: z.array(Share),
            abilities: z.array(Share),
            spreads: z.array(
              z.object({
                nature: NatureSchema,
                sp: StatsTableSchema,
                share: z.number().min(0).max(1),
              }),
            ),
            teammates: z.array(Share),
          })
          .optional(),
      }),
    )
    .min(1),
});
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>;

export const ArchetypesSchema = z.object({
  note: z.string().optional(),
  archetypes: z.array(
    z.object({
      id: z.string(),
      name: z.object({ ja: z.string(), en: z.string() }),
      minMatches: z.number().int().positive().default(1),
      conditions: z
        .array(
          z
            .object({
              species: z.string().optional(),
              item: z.string().optional(),
              basis: z.enum(["computed", "estimated"]),
              why: z.string(),
            })
            .refine((c) => c.species !== undefined || c.item !== undefined, {
              message: "species or item required",
            }),
        )
        .min(1),
    }),
  ),
});
export type Archetypes = z.infer<typeof ArchetypesSchema>;
