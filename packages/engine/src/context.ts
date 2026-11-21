import { Generations } from "@smogon/calc";
import {
  STAT_IDS,
  type EngineTags,
  type GameSpec,
  type PokemonSet,
  type PokemonType,
  type ResolvedPack,
  type StatsTable,
  type UsageSnapshot,
} from "@ca/schema";
import { baseDex, dexWithNewSpecies, displayName, engineTags, moveMeta, type Dex } from "@ca/data";
import { ChampionsCalc } from "@ca/calc";

const gen = Generations.get(9);
export const ATTACK_TYPES: readonly PokemonType[] = [
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
];

export interface Threat {
  species: string;
  usage: number;
  set: PokemonSet;
  mega: boolean;
}

export class RuleParamError extends Error {
  override name = "RuleParamError";
}

/** Everything a rule may read. Pure and deterministic. */
export class RuleContext {
  readonly calc: ChampionsCalc;
  readonly tags: EngineTags;
  readonly dex: Dex;
  readonly threats: Threat[];

  constructor(
    readonly team: readonly PokemonSet[],
    readonly pack: ResolvedPack,
    readonly spec: GameSpec,
    readonly usage?: UsageSnapshot,
  ) {
    this.calc = new ChampionsCalc(pack, spec);
    this.tags = engineTags();
    this.dex = dexWithNewSpecies(baseDex(), pack.overrides.newSpecies);
    this.threats = (usage?.entries ?? [])
      .filter((e) => e.sets.length > 0 && pack.legal.species.includes(e.species))
      .map((e) => {
        const s = [...e.sets].sort((a, b) => b.share - a.share)[0]!;
        const set: PokemonSet = {
          species: e.species,
          ability: s.ability,
          nature: s.nature,
          sp: s.sp,
          moves: s.moves,
          confidence: {},
          assumed: [],
          ...(s.item ? { item: s.item } : {}),
        };
        return { species: e.species, usage: e.usage, set, mega: s.mega };
      })
      .sort((a, b) => b.usage - a.usage || a.species.localeCompare(b.species));
  }

  /** A required numeric parameter from weights.json (`params[ruleId][key]`). */
  param(ruleId: string, key: string): number {
    const v = this.pack.weights.params[ruleId]?.[key];
    if (v === undefined)
      throw new RuleParamError(
        `weights.params["${ruleId}"]["${key}"] is missing in ${this.pack.id}`,
      );
    return v;
  }

  name(id: string, kind: "species" | "moves" | "items" | "abilities" = "species"): string {
    return displayName(kind, id);
  }

  /** True if this member holds a Mega Stone it can use under this regulation. */
  canMega(m: PokemonSet): boolean {
    if (!this.pack.mechanics.includes("mega") || !m.item) return false;
    if (!this.pack.legal.megaSpecies.includes(m.species)) return false;
    return (
      this.dex
        .megaStones()
        .get(m.item)
        ?.some((e) => e.baseId === m.species) ?? false
    );
  }

  /** Species ID in battle (Mega forme if it holds its stone). */
  formeInBattle(m: PokemonSet): string {
    return this.canMega(m) ? this.calc.formeOf({ set: m, mega: true }) : m.species;
  }

  types(speciesId: string): PokemonType[] {
    const added = this.pack.overrides.newSpecies[speciesId];
    if (added) return added.types;
    const o = this.pack.overrides.species[speciesId]?.types;
    return (o ??
      (gen.species.get(speciesId as never)?.types as PokemonType[] | undefined) ??
      []) as PokemonType[];
  }

  /** Abilities the member can have active: its own, plus the Mega forme's once it Mega Evolves. */
  abilities(m: PokemonSet): string[] {
    const out = [m.ability];
    if (this.canMega(m)) {
      const mega = gen.species.get(this.formeInBattle(m) as never)?.abilities?.[0];
      if (mega) out.push(toAbilityId(mega));
    }
    return [...new Set(out)];
  }

  /** Type effectiveness of `type` against a species, with the given abilities' immunities. */
  effectiveness(type: PokemonType, speciesId: string, abilities: readonly string[] = []): number {
    if (abilities.some((a) => this.tags.abilities.typeImmunity[a] === type)) return 0;
    let e = 1;
    for (const t of this.types(speciesId))
      e *= gen.types.get(type.toLowerCase() as never)?.effectiveness[t as never] ?? 1;
    return e;
  }

  /**
   * Damaging moves of a member as [moveId, type], after -ate abilities (incl. the Mega forme's,
   * e.g. Mega Gardevoir's Pixilate). Weather Ball etc. use their base type.
   */
  attackingMoves(m: PokemonSet): { id: string; type: PokemonType }[] {
    const changes = this.abilities(m)
      .map((a) => this.tags.abilities.typeChange[a])
      .filter((x): x is { from: PokemonType; to: PokemonType } => x !== undefined);
    const convert = (t: PokemonType) => changes.find((c) => c.from === t)?.to ?? t;
    return (
      m.moves
        .map((id) => ({ id, mv: gen.moves.get(id as never), meta: moveMeta(id) }))
        // basePower 0 on a non-status move = variable power (Heavy Slam, Low Kick…), still an attack
        .filter((x) => x.mv && x.mv.category !== "Status")
        .map((x) => ({
          id: x.id,
          type: convert((this.pack.overrides.moves[x.id]?.type ?? x.mv!.type) as PokemonType),
        }))
    );
  }

  stats(m: PokemonSet, mega = false): StatsTable {
    return this.calc.stats({ set: m, mega: mega && this.canMega(m) });
  }

  /** SP left unassigned (0 for a full spread). */
  freeSp(m: PokemonSet): number {
    return this.spec.statPoints.total.value - STAT_IDS.reduce((a, s) => a + m.sp[s], 0);
  }

  membersWithMove(
    ids: readonly string[] | Record<string, unknown>,
  ): { member: PokemonSet; moves: string[] }[] {
    const set = new Set(Array.isArray(ids) ? ids : Object.keys(ids));
    return this.team
      .map((member) => ({ member, moves: member.moves.filter((x) => set.has(x)) }))
      .filter((x) => x.moves.length > 0);
  }

  membersWithAbility(
    ids: readonly string[] | Record<string, unknown>,
  ): { member: PokemonSet; abilities: string[] }[] {
    const set = new Set(Array.isArray(ids) ? ids : Object.keys(ids));
    return this.team
      .map((member) => ({ member, abilities: this.abilities(member).filter((x) => set.has(x)) }))
      .filter((x) => x.abilities.length > 0);
  }
}

function toAbilityId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
