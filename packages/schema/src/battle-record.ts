import { z } from "zod";
import { IdSchema } from "./id.js";
import { PokemonSetSchema } from "./team.js";

/**
 * A real battle record (R-0: policy evaluation). Entered by hand or converted from a Showdown
 * replay log the user saved. Never collected automatically (OPEN_QUESTIONS D-02).
 */

/** One active Pokémon's observed state at the start of a turn. */
export const RecordMonStateSchema = z.object({
  species: IdSchema,
  /** remaining HP in percent (0..100) */
  hpPct: z.number().min(0).max(100),
  status: z.enum(["brn", "par", "slp", "frz", "psn", "tox"]).nullable().optional(),
  boosts: z.record(z.string(), z.number().int().min(-6).max(6)).optional(),
});
export type RecordMonState = z.infer<typeof RecordMonStateSchema>;

/** What one active slot did. `unknown`: not observable (flinched, fainted before moving …). */
export const RecordSlotActionSchema = z.union([
  z.object({
    move: IdSchema,
    /** target species (foe or ally); omitted for spread / self moves */
    target: IdSchema.optional(),
    mega: z.boolean().optional(),
  }),
  z.object({ switch: IdSchema }),
  z.object({ pass: z.literal(true) }),
  z.object({ unknown: z.literal(true) }),
]);
export type RecordSlotAction = z.infer<typeof RecordSlotActionSchema>;

export const RecordTurnSchema = z.object({
  turn: z.number().int().min(1),
  /** Observed state at the start of the turn, per side: the active Pokémon (slot order). */
  state: z.tuple([z.array(RecordMonStateSchema), z.array(RecordMonStateSchema)]).optional(),
  /** Per side, per active slot. */
  actions: z.tuple([z.array(RecordSlotActionSchema), z.array(RecordSlotActionSchema)]),
  /** Pokémon sent in by switch requests during / after this turn (U-turn, Eject Button, after a
   * faint), per side, in order (species). */
  replacements: z.tuple([z.array(IdSchema), z.array(IdSchema)]).optional(),
});
export type RecordTurn = z.infer<typeof RecordTurnSchema>;

/** A team: either pasted text (Showdown / ポケペースト) or parsed sets. */
export const RecordTeamSchema = z.union([z.string(), z.array(PokemonSetSchema).min(1).max(6)]);

export const BattleRecordSchema = z
  .object({
    id: z.string().min(1),
    regulationId: z.string(),
    source: z.enum(["manual", "showdown-log"]),
    note: z.string().optional(),
    /** [side 0, side 1] full team sheets (6 for selection evaluation). */
    teams: z.tuple([RecordTeamSchema, RecordTeamSchema]),
    /** Per side, the 4 brought species in order: the first two led. */
    brought: z.tuple([z.array(IdSchema).min(2).max(4), z.array(IdSchema).min(2).max(4)]),
    /** 0/1 = winner side, null = unknown / draw */
    winner: z.union([z.literal(0), z.literal(1), z.null()]).optional(),
    turns: z.array(RecordTurnSchema).default([]),
    /** Raw Showdown battle log; converted to `turns` (and `brought`) when `turns` is empty. */
    showdownLog: z.string().optional(),
  })
  .refine((r) => r.turns.length > 0 || r.showdownLog !== undefined, {
    message: "turns or showdownLog is required",
  });
export type BattleRecord = z.infer<typeof BattleRecordSchema>;
export type BattleRecordInput = z.input<typeof BattleRecordSchema>;
