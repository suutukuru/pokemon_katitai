// Thin typed wrapper around pokemon-showdown (MIT). Only the parts we use are typed.
import ps from "pokemon-showdown";
import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";

export const { Battle, Dex } = ps as unknown as { Battle: BattleCtor; Dex: DexApi };

export interface DexApi {
  forFormat(format: string): ModdedDex;
}
export interface ModdedDex {
  moves: { get(id: string): PsMove };
  species: {
    get(id: string): { name: string; exists: boolean; baseStats: Record<string, number> };
  };
  items: { get(id: string): { name: string; exists: boolean } };
  abilities: { get(id: string): { name: string; exists: boolean } };
  getEffectiveness(type: string, target: string[]): number;
  getImmunity(type: string, target: string[]): boolean;
}
export interface PsMove {
  id: string;
  name: string;
  type: string;
  category: "Physical" | "Special" | "Status";
  basePower: number;
  accuracy: number | true;
  target: string;
  priority: number;
  multihit?: number | [number, number];
  boosts?: Record<string, number> | null;
  status?: string;
  flags: Record<string, number>;
  secondary?: { chance?: number; boosts?: Record<string, number> } | null;
  heal?: number[] | null;
  willCrit?: boolean;
  recoil?: [number, number];
  drain?: [number, number];
}
export interface PsPokemon {
  name: string;
  species: { id: string; name: string; weightkg?: number };
  moveSlots?: { id: string; pp: number; disabled?: boolean | string }[];
  hp: number;
  maxhp: number;
  fainted: boolean;
  status: string;
  ability: string;
  item: string;
  boosts: Record<string, number>;
  volatiles: Record<string, unknown>;
  activeMoveActions: number;
  position: number;
  side: PsSide;
  getStat(stat: string, unboosted?: boolean, unmodified?: boolean): number;
  /** Speed used for turn order (tailwind, scarf, paralysis, Swift Swim…; Trick Room inverts). */
  getActionSpeed(): number;
  isGrounded(): boolean;
  getTypes(): string[];
  hasType(t: string): boolean;
}
export interface PsSide {
  id: "p1" | "p2";
  name: string;
  active: (PsPokemon | null)[];
  pokemon: PsPokemon[];
  sideConditions: Record<string, unknown>;
  activeRequest: PsRequest | null;
  isChoiceDone(): boolean;
  foe: PsSide;
}
export interface PsRequestMove {
  move: string;
  id: string;
  target?: string;
  disabled?: boolean | string;
  pp?: number;
}
export interface PsRequest {
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: { moves: PsRequestMove[]; canMegaEvo?: boolean; trapped?: boolean }[];
  side: { pokemon: { active: boolean; condition: string; ident: string }[] };
}
export interface PsBattle {
  sides: [PsSide, PsSide];
  field: { weather: string; pseudoWeather: Record<string, unknown>; terrain: string };
  turn: number;
  ended: boolean;
  winner: string;
  dex: ModdedDex;
  log: string[];
  setPlayer(slot: "p1" | "p2", opts: { name: string; team: ShowdownSet[] }): void;
  choose(side: "p1" | "p2", choice: string): boolean;
}
type BattleCtor = new (opts: {
  formatid: string;
  seed: [number, number, number, number];
}) => PsBattle;

export interface ShowdownSet {
  name: string;
  species: string;
  item: string;
  ability: string;
  nature: string;
  /** Champions mod: `evs` holds stat points (SP), see data/mods/champions/scripts.ts */
  evs: Record<string, number>;
  ivs: Record<string, number>;
  level: number;
  moves: string[];
  gender: string;
}

/** Our PokemonSet → Showdown set (names from our name table, English). */
export function toShowdownSet(set: PokemonSet, iv: number, level: number): ShowdownSet {
  const species = displayName("species", set.species, "en").replace(/ \((.+)\)$/, "");
  return {
    name: set.nickname ?? species,
    species: showdownSpeciesName(set.species),
    item: set.item ? displayName("items", set.item, "en") : "",
    ability: displayName("abilities", set.ability, "en"),
    nature: set.nature,
    evs: { ...set.sp },
    ivs: { hp: iv, atk: iv, def: iv, spa: iv, spd: iv, spe: iv },
    level,
    moves: set.moves.map((m) => displayName("moves", m, "en")),
    gender: set.gender && set.gender !== "N" ? set.gender : "",
  };
}

/** Showdown resolves IDs itself ("indeedeef" → Indeedee-F), so pass the ID. */
function showdownSpeciesName(id: string): string {
  return id;
}
