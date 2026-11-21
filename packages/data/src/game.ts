import { GameSpecSchema, type GameSpec } from "@ca/schema";
import raw from "../game/champions.json" with { type: "json" };

let cached: GameSpec | undefined;
/** Game-wide Champions constants (SP caps, level, IVs). Validated on first access. */
export function gameSpec(): GameSpec {
  return (cached ??= GameSpecSchema.parse(raw));
}
