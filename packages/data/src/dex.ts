import { Generations } from "@smogon/calc";
import { toID, type ResolvedPack } from "@ca/schema";

export interface MegaEvolution {
  baseId: string;
  megaId: string;
}

export interface DexSpecies {
  id: string;
  name: string;
  /** ID of the base species (itself for base formes). */
  baseId: string;
  isMega: boolean;
}

/** Read-only lookup of what exists in the game, independent of what is legal. */
export interface Dex {
  readonly source: string;
  species(id: string): DexSpecies | undefined;
  hasMove(id: string): boolean;
  hasItem(id: string): boolean;
  hasAbility(id: string): boolean;
  /** Mega stone item ID → the (base species, Mega forme) pairs it works for (Meowsticite has two). */
  megaStones(): ReadonlyMap<string, readonly MegaEvolution[]>;
  /** All IDs of a kind (sorted). */
  ids(kind: "species" | "moves" | "items" | "abilities"): readonly string[];
}

const gen9 = Generations.get(9);

function buildBaseDex(): Dex {
  const species = new Map<string, DexSpecies>();
  for (const s of gen9.species) {
    const baseId = toID(s.baseSpecies ?? s.name);
    species.set(s.id, { id: s.id, name: s.name, baseId, isMega: /-Mega(-|$)/.test(s.name) });
  }
  const megaStones = new Map<string, MegaEvolution[]>();
  for (const it of gen9.items) {
    if (it.megaStone) {
      megaStones.set(
        it.id,
        Object.entries(it.megaStone).map(([base, mega]) => ({
          baseId: toID(base),
          megaId: toID(mega),
        })),
      );
    }
  }
  const moves = new Set<string>([...gen9.moves].map((m) => m.id));
  const items = new Set<string>([...gen9.items].map((i) => i.id));
  const abilities = new Set<string>([...gen9.abilities].map((a) => a.id));
  const ids = {
    species: [...species.keys()].sort(),
    moves: [...moves].sort(),
    items: [...items].sort(),
    abilities: [...abilities].sort(),
  };
  return {
    source: "@smogon/calc gen9",
    ids: (kind) => ids[kind],
    species: (id) => species.get(id),
    hasMove: (id) => moves.has(id),
    hasItem: (id) => items.has(id),
    hasAbility: (id) => abilities.has(id),
    megaStones: () => megaStones,
  };
}

let cached: Dex | undefined;
/** The base dex (Gen 9 data from @smogon/calc). See ADR-0003. */
export function baseDex(): Dex {
  return (cached ??= buildBaseDex());
}

/** Dex extended with a pack's `overrides.newSpecies`. */
export function dexWithNewSpecies(
  base: Dex,
  newSpecies: ResolvedPack["overrides"]["newSpecies"],
): Dex {
  const extra = new Map<string, DexSpecies>();
  for (const [id, s] of Object.entries(newSpecies)) {
    extra.set(id, {
      id,
      name: s.name,
      baseId: s.baseSpecies ?? id,
      isMega: /-Mega(-|$)/.test(s.name),
    });
  }
  if (extra.size === 0) return base;
  return {
    ...base,
    species: (id) => extra.get(id) ?? base.species(id),
    ids: (kind) =>
      kind === "species"
        ? [...new Set([...base.ids("species"), ...extra.keys()])].sort()
        : base.ids(kind),
  };
}
