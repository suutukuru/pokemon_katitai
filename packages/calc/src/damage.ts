import {
  calculate,
  Field as SmogonField,
  Generations,
  Move as SmogonMove,
  Pokemon as SmogonPokemon,
} from "@smogon/calc";
import type { GameSpec, PokemonSet, ResolvedPack, StatId, StatsTable } from "@ca/schema";
import { baseDex, dexWithNewSpecies, displayName, moveMeta, type Dex } from "@ca/data";
import { calcStats, spToEv, validateSp } from "./stats.js";

const gen = Generations.get(9);
type SmogonOverrides = NonNullable<ConstructorParameters<typeof SmogonPokemon>[2]>["overrides"];

export type Weather = "Sun" | "Rain" | "Sand" | "Snow";
export type Terrain = "Electric" | "Grassy" | "Psychic" | "Misty";
export type Status = "brn" | "par" | "psn" | "tox" | "slp" | "frz";

export interface Battler {
  set: PokemonSet;
  /** Use the Mega forme (requires the matching Mega Stone and the `mega` mechanic). */
  mega?: boolean;
  boosts?: Partial<Record<Exclude<StatId, "hp">, number>>;
  status?: Status;
  /** Current HP; defaults to full. */
  curHp?: number;
  /** For conditional abilities (e.g. Flash Fire activated). */
  abilityOn?: boolean;
}

export interface SideConditions {
  reflect?: boolean;
  lightScreen?: boolean;
  auroraVeil?: boolean;
  friendGuard?: boolean;
  helpingHand?: boolean;
}

export interface FieldInput {
  weather?: Weather;
  terrain?: Terrain;
  attackerSide?: SideConditions;
  defenderSide?: SideConditions;
}

export interface DamageResult {
  attacker: string;
  defender: string;
  move: string;
  /** Total-damage outcomes with probabilities (multi-hit moves are convolved). Sorted by damage. */
  distribution: { damage: number; p: number }[];
  min: number;
  max: number;
  defenderHp: number;
  /** [min, max] as % of the defender's max HP, 1 decimal. */
  percent: [number, number];
  /** P(this hit KOs from current HP), before accuracy, given crit/no-crit. */
  ohko: { noCrit: number; crit: number };
  /** Base accuracy (0..1); 1 for moves that cannot miss. */
  accuracy: number;
  /** P(crit) used for `koChanceOneHit`. 1 for always-crit moves (e.g. Flower Trick). */
  critChance: number;
  /** P(KO with this single use) = accuracy × [(1-c)·noCrit + c·crit]. */
  koChanceOneHit: number;
  /** n-hit KO estimate from @smogon/calc (`n` = hits, `chance` 0..1), excluding accuracy. */
  nhko: { n: number; chance: number | undefined; text: string };
  /** Stats used for this calc (after Mega Evolution), for evidence. */
  attackerStats: StatsTable;
  defenderStats: StatsTable;
  /** Smogon's one-line description, kept for debugging only. */
  description: string;
}

export class CalcError extends Error {
  override name = "CalcError";
}

/**
 * Champions damage calculator. Applies the regulation pack's overrides and the
 * game's stat formula on top of @smogon/calc (Gen 9 mechanics, doubles). See ADR-0003.
 */
export class ChampionsCalc {
  private readonly dex: Dex;

  constructor(
    readonly pack: ResolvedPack,
    readonly spec: GameSpec,
  ) {
    this.dex = dexWithNewSpecies(baseDex(), pack.overrides.newSpecies);
  }

  /** Species ID after (optional) Mega Evolution. */
  formeOf(b: Battler): string {
    if (!b.mega) return b.set.species;
    if (!this.pack.mechanics.includes("mega")) {
      throw new CalcError(`regulation ${this.pack.id} does not enable Mega Evolution`);
    }
    const evo = b.set.item
      ? this.dex
          .megaStones()
          .get(b.set.item)
          ?.find((e) => e.baseId === b.set.species)
      : undefined;
    if (!evo)
      throw new CalcError(`${b.set.species} cannot Mega Evolve holding ${b.set.item ?? "no item"}`);
    return evo.megaId;
  }

  private speciesOverrides(id: string): SmogonOverrides | undefined {
    const added = this.pack.overrides.newSpecies[id];
    if (added) {
      return {
        name: added.name,
        baseStats: added.baseStats,
        types: added.types as never,
        weightkg: added.weightkg,
        abilities: { 0: added.abilities[0] ?? "" },
      } as unknown as SmogonOverrides;
    }
    const o = this.pack.overrides.species[id];
    if (!o) return undefined;
    const current = gen.species.get(id as never);
    const out: Record<string, unknown> = {};
    if (o.baseStats) out["baseStats"] = { ...current?.baseStats, ...o.baseStats };
    if (o.types) out["types"] = o.types;
    return out as SmogonOverrides;
  }

  /** Base stats for a species/forme, with pack overrides applied. */
  baseStats(id: string): StatsTable {
    const added = this.pack.overrides.newSpecies[id];
    if (added) return added.baseStats;
    const s = gen.species.get(id as never);
    if (!s) throw new CalcError(`unknown species "${id}"`);
    return { ...s.baseStats, ...this.pack.overrides.species[id]?.baseStats } as StatsTable;
  }

  /** Final (unboosted) stats in battle. */
  stats(b: Battler): StatsTable {
    return calcStats(this.spec, this.baseStats(this.formeOf(b)), b.set.sp, b.set.nature);
  }

  private toSmogon(b: Battler): SmogonPokemon {
    const issues = validateSp(this.spec, b.set.sp);
    if (issues.length)
      throw new CalcError(`${b.set.species}: ${issues.map((i) => i.message).join("; ")}`);
    const forme = this.formeOf(b);
    const overrides = this.speciesOverrides(forme);
    const name =
      this.pack.overrides.newSpecies[forme]?.name ?? gen.species.get(forme as never)?.name;
    if (!name) throw new CalcError(`unknown species "${forme}"`);
    const megaAbility = b.mega ? gen.species.get(forme as never)?.abilities?.[0] : undefined;
    const p = new SmogonPokemon(gen, name, {
      level: this.pack.rules.level,
      nature: b.set.nature,
      ability: megaAbility ?? gen.abilities.get(b.set.ability as never)?.name ?? b.set.ability,
      ...(b.set.item ? { item: gen.items.get(b.set.item as never)?.name ?? b.set.item } : {}),
      evs: Object.fromEntries(Object.entries(b.set.sp).map(([k, v]) => [k, spToEv(v)])),
      ivs: {
        hp: this.spec.iv.value,
        atk: this.spec.iv.value,
        def: this.spec.iv.value,
        spa: this.spec.iv.value,
        spd: this.spec.iv.value,
        spe: this.spec.iv.value,
      },
      ...(b.boosts ? { boosts: b.boosts } : {}),
      ...(b.status ? { status: b.status } : {}),
      ...(b.curHp !== undefined ? { curHP: b.curHp } : {}),
      ...(b.abilityOn !== undefined ? { abilityOn: b.abilityOn } : {}),
      ...(b.set.gender ? { gender: b.set.gender } : {}),
      ...(overrides ? { overrides } : {}),
    });
    // The Champions formula is authoritative; overwrite whatever smogon derived from EVs.
    const stats = this.stats(b);
    for (const [k, v] of Object.entries(stats)) {
      (p.rawStats as Record<string, number>)[k] = v;
      (p.stats as Record<string, number>)[k] = v;
    }
    p.originalCurHP = Math.min(b.curHp ?? stats.hp, stats.hp);
    return p;
  }

  private toMove(moveId: string, attacker: SmogonPokemon, crit: boolean): SmogonMove {
    const m = gen.moves.get(moveId as never);
    if (!m) throw new CalcError(`unknown move "${moveId}"`);
    if (this.pack.legal.bannedMoves.includes(moveId))
      throw new CalcError(`move "${moveId}" is banned in ${this.pack.id}`);
    const o = this.pack.overrides.moves[moveId];
    const overrides: Record<string, unknown> = {};
    if (o?.basePower !== undefined) overrides["basePower"] = o.basePower;
    if (o?.type !== undefined) overrides["type"] = o.type;
    if (o?.category !== undefined) overrides["category"] = o.category;
    if (o?.priority !== undefined) overrides["priority"] = o.priority;
    return new SmogonMove(gen, m.name, {
      ...(attacker.ability ? { ability: attacker.ability } : {}),
      ...(attacker.item ? { item: attacker.item } : {}),
      species: attacker.name,
      isCrit: crit,
      ...(Object.keys(overrides).length ? { overrides: overrides as never } : {}),
    });
  }

  private toField(f: FieldInput): SmogonField {
    const side = (s: SideConditions | undefined) => ({
      isReflect: !!s?.reflect,
      isLightScreen: !!s?.lightScreen,
      isAuroraVeil: !!s?.auroraVeil,
      isFriendGuard: !!s?.friendGuard,
      isHelpingHand: !!s?.helpingHand,
    });
    return new SmogonField({
      gameType: this.pack.rules.format === "doubles" ? "Doubles" : "Singles",
      ...(f.weather ? { weather: f.weather } : {}),
      ...(f.terrain ? { terrain: f.terrain } : {}),
      attackerSide: side(f.attackerSide),
      defenderSide: side(f.defenderSide),
    });
  }

  damage(
    attacker: Battler,
    defender: Battler,
    moveId: string,
    field: FieldInput = {},
  ): DamageResult {
    const atk = this.toSmogon(attacker);
    const def = this.toSmogon(defender);
    const run = (crit: boolean) =>
      calculate(gen, atk, def, this.toMove(moveId, atk, crit), this.toField(field));
    const normal = run(false);
    const crit = run(true);
    const dist = distributionOf(normal.damage);
    const critDist = distributionOf(crit.damage);
    const hp = def.originalCurHP;
    const maxHp = def.rawStats.hp;
    const pKo = (d: { damage: number; p: number }[]) =>
      d.filter((x) => x.damage >= hp).reduce((a, x) => a + x.p, 0);
    const move = gen.moves.get(moveId as never)!;
    const moveData = move as unknown as { willCrit?: boolean };
    const meta = moveMeta(moveId);
    if (!meta) throw new CalcError(`no accuracy data for move "${moveId}"`);
    const accuracyRaw = this.pack.overrides.moves[moveId]?.accuracy ?? meta.accuracy ?? true;
    const accuracy = accuracyRaw === true ? 1 : accuracyRaw / 100;
    const cc = this.spec.critChance.value;
    const critChance = moveData.willCrit ? 1 : cc.numerator / cc.denominator;
    const ohko = { noCrit: pKo(dist), crit: pKo(critDist) };
    let ko: { chance?: number | undefined; n: number; text: string };
    try {
      ko = normal.kochance();
    } catch {
      ko = { n: 0, text: "" };
    }
    const min = dist[0]?.damage ?? 0;
    const max = dist.at(-1)?.damage ?? 0;
    const pct = (x: number) => Math.round((x / maxHp) * 1000) / 10;
    return {
      attacker: attacker.set.species,
      defender: defender.set.species,
      move: moveId,
      distribution: dist,
      min,
      max,
      defenderHp: hp,
      percent: [pct(min), pct(max)],
      ohko,
      accuracy,
      critChance,
      koChanceOneHit: accuracy * ((1 - critChance) * ohko.noCrit + critChance * ohko.crit),
      nhko: { n: ko.n, chance: ko.chance, text: ko.text },
      attackerStats: this.stats(attacker),
      defenderStats: this.stats(defender),
      description: safeDesc(normal),
    };
  }

  /** Display label, e.g. "リザードン". */
  label(id: string, lang: "ja" | "en" = "ja"): string {
    return displayName("species", id, lang);
  }
}

function safeDesc(r: { desc(): string }): string {
  try {
    return r.desc();
  } catch {
    return "";
  }
}

/**
 * Smogon returns a number (fixed damage / immune), number[] (16 rolls) or number[][] (per-hit rolls).
 * Convert to an exact probability distribution of total damage.
 */
export function distributionOf(
  damage: number | number[] | number[][],
): { damage: number; p: number }[] {
  const hits: number[][] =
    typeof damage === "number"
      ? [[damage]]
      : Array.isArray(damage[0])
        ? (damage as number[][])
        : [damage as number[]];
  let acc = new Map<number, number>([[0, 1]]);
  for (const rolls of hits) {
    const next = new Map<number, number>();
    for (const [d, p] of acc) {
      for (const r of rolls) next.set(d + r, (next.get(d + r) ?? 0) + p / rolls.length);
    }
    acc = next;
  }
  return [...acc].sort(([a], [b]) => a - b).map(([damage, p]) => ({ damage, p }));
}
