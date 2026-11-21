import type { PokemonSet, ResolvedPack } from "@ca/schema";

/**
 * A battle mechanic that data alone cannot express (ADR-0002 §mechanics).
 * Only plugins listed in the regulation manifest's `mechanics` are active.
 */
export interface Mechanic {
  id: string;
  description: string;
  /** Extra per-turn choices this mechanic adds for a member (e.g. "mega evolve or not"). */
  enumerateExtraActions(member: PokemonSet, ctx: MechanicContext): string[];
}

export interface MechanicContext {
  pack: ResolvedPack;
  /** Whether this side has already used the mechanic this battle. */
  used: boolean;
  /** Mega stone item → base species, from the dex. */
  canMega(member: PokemonSet): boolean;
}

export const megaMechanic: Mechanic = {
  id: "mega",
  description: "メガシンカ（1試合の回数は rules.megaPerBattle）",
  enumerateExtraActions(member, ctx) {
    return !ctx.used && ctx.canMega(member) ? ["mega"] : [];
  },
};

/** Registry of all implemented mechanics. Pass `MECHANIC_IDS` to `loadPack({ knownMechanics })`. */
export const MECHANICS: readonly Mechanic[] = [megaMechanic];
export const MECHANIC_IDS: readonly string[] = MECHANICS.map((m) => m.id);

export function activeMechanics(pack: ResolvedPack): Mechanic[] {
  return MECHANICS.filter((m) => pack.mechanics.includes(m.id));
}
