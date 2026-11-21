import { z } from "zod";
import { SourceSchema } from "./common.js";

/**
 * Game-wide constants for Pokémon Champions (independent of regulation).
 * Values are data, never hard-coded in calc/engine. See docs/OPEN_QUESTIONS.md Q-01/Q-02.
 */
const Verified = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    verified: z.boolean(),
    sources: z.array(SourceSchema).default([]),
    note: z.string().optional(),
  });

export const GameSpecSchema = z.object({
  id: z.literal("champions"),
  level: Verified(z.number().int().min(1).max(100)),
  iv: Verified(z.number().int().min(0).max(31)),
  statPoints: z.object({
    total: Verified(z.number().int().positive()),
    perStat: Verified(z.number().int().positive()),
    /** Flat stat increase per SP at the battle level. */
    statPerPoint: Verified(z.number().int().positive()),
  }),
  natureMultiplier: Verified(z.object({ up: z.number(), down: z.number() })),
  /** Base critical-hit chance at stage 0, as a fraction. */
  critChance: Verified(
    z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }),
  ),
  /** Critical-hit damage multiplier. */
  critMultiplier: Verified(z.number().positive()),
});
export type GameSpec = z.infer<typeof GameSpecSchema>;
