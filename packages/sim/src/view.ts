// Plain-data views of a Showdown battle for UIs (web board, reports). No Showdown objects leak out.
import { engineTags } from "@ca/data";
import { allJointOptions, chooseFor, forcedSwitchOptions, type SlotOption } from "./policy.js";
import { restore, reseed, snap, type Snapshot } from "./replay.js";
import { Rng } from "./rng.js";
import { markLogSent, type SimContext } from "./runner.js";
import type { PsBattle, PsPokemon } from "./showdown.js";
import { positionKey } from "./search.js";
import { parseLog, type BattleEvent } from "./trace.js";

export interface MonView {
  /** species ID of the set (base form) */
  species: string;
  /** current forme ID (e.g. after Mega Evolution) */
  forme: string;
  hp: number;
  maxhp: number;
  status: string;
  fainted: boolean;
  active: boolean;
  item: string;
  ability: string;
  types: string[];
  boosts: Record<string, number>;
  moves: { id: string; pp: number; maxpp: number }[];
  /** team position (1-based, Showdown's switch index) */
  index: number;
}

export interface SideView {
  active: (MonView | null)[];
  /** brought Pokémon not on the field (incl. fainted) */
  bench: MonView[];
  conditions: string[];
}

export type RequestKind = "move" | "switch" | "wait" | null;

export interface BattleView {
  /** positionKey (search.ts) */
  key: string;
  turn: number;
  ended: boolean;
  /** 0 = p1 won, 1 = p2 won, null = not over / draw */
  winner: 0 | 1 | null;
  sides: [SideView, SideView];
  weather: string;
  terrain: string;
  pseudoWeather: string[];
  request: [RequestKind, RequestKind];
}

function monView(m: PsPokemon, index: number): MonView {
  const any = m as unknown as {
    set: { species: string };
    moveSlots: { id: string; pp: number; maxpp: number }[];
    isActive: boolean;
  };
  return {
    species: any.set.species.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    forme: m.species.id,
    hp: m.hp,
    maxhp: m.maxhp,
    status: m.status,
    fainted: m.fainted || m.hp <= 0,
    active: any.isActive,
    item: m.item,
    ability: m.ability,
    types: m.getTypes(),
    boosts: Object.fromEntries(Object.entries(m.boosts).filter(([, v]) => v !== 0)),
    moves: any.moveSlots.map((s) => ({ id: s.id, pp: s.pp, maxpp: s.maxpp })),
    index,
  };
}

function requestKind(b: PsBattle, s: 0 | 1): RequestKind {
  const side = b.sides[s];
  const r = side.activeRequest;
  if (b.ended || !r) return null;
  if (r.wait || side.isChoiceDone()) return "wait";
  if (r.forceSwitch) return "switch";
  return r.active ? "move" : null;
}

export function battleView(b: PsBattle): BattleView {
  const sides = b.sides.map((side) => {
    const active = side.active.map((m) =>
      m && !m.fainted ? monView(m, side.pokemon.indexOf(m) + 1) : null,
    );
    const bench = side.pokemon
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => !side.active.includes(m) || m.fainted)
      .map(({ m, i }) => monView(m, i + 1));
    return { active, bench, conditions: Object.keys(side.sideConditions).sort() };
  }) as [SideView, SideView];
  return {
    key: positionKey(b),
    turn: b.turn,
    ended: b.ended,
    winner: !b.ended ? null : b.winner === "A" ? 0 : b.winner === "B" ? 1 : null,
    sides,
    weather: b.field.weather,
    terrain: b.field.terrain,
    pseudoWeather: Object.keys(b.field.pseudoWeather).sort(),
    request: [requestKind(b, 0), requestKind(b, 1)],
  };
}

export const viewOf = (state: Snapshot): BattleView => battleView(restore(state));

export interface StepResult {
  state: Snapshot;
  events: BattleEvent[];
  view: BattleView;
  /** the choices that were actually sent */
  choices: [string, string];
}

/**
 * Apply both sides' choices to a position. An empty choice lets the policy choose. With
 * `reroll` the battle's random numbers are re-seeded first (another outcome of the same turn);
 * without it the battle keeps its own RNG, so the same choices give the same result.
 * The step runs until some side has a new decision to make (or the battle ends).
 */
export function step(
  ctx: SimContext,
  state: Snapshot,
  a: string,
  b: string,
  opts: { reroll?: number; policySeed?: number } = {},
): StepResult {
  const battle = restore(state);
  if (opts.reroll !== undefined) reseed(battle, opts.reroll);
  const from = battle.log.length;
  const rng = new Rng(opts.policySeed ?? 1);
  const tags = engineTags();
  const sent: [string, string] = ["", ""];
  ([0, 1] as const).forEach((s) => {
    const side = battle.sides[s];
    const r = side.activeRequest;
    if (!r || r.wait || side.isChoiceDone()) return;
    const c = (s === 0 ? a : b) || chooseFor(battle, side, tags, ctx.params, rng);
    sent[s] = c;
    if (!battle.choose(side.id, c)) {
      battle.choose(side.id, "default");
      sent[s] = "default";
    }
  });
  markLogSent(battle);
  const events = [...parseLog(battle, from).values()].flat();
  return { state: snap(battle), events, view: battleView(battle), choices: sent };
}

export interface SlotChoiceView {
  slot: number;
  species: string;
  options: SlotOption[];
}

/** Every legal option per active slot (for building a custom joint action), plus forced switches. */
export function slotChoices(
  ctx: SimContext,
  state: Snapshot,
  s: 0 | 1,
): { kind: RequestKind; slots: SlotChoiceView[]; switches: string[] } {
  const battle = restore(state);
  const kind = requestKind(battle, s);
  const side = battle.sides[s];
  if (kind === "switch")
    return { kind, slots: [], switches: forcedSwitchOptions(side, side.activeRequest!) };
  if (kind !== "move") return { kind, slots: [], switches: [] };
  const { perSlot } = allJointOptions(battle, side, engineTags(), ctx.params);
  return {
    kind,
    slots: perSlot.map((options, slot) => ({
      slot,
      species: side.active[slot]?.species.id ?? "",
      options,
    })),
    switches: [],
  };
}

/** Is a joint choice string legal here? (Showdown validates it on a throwaway copy.) */
export function isLegal(state: Snapshot, s: 0 | 1, choice: string): boolean {
  const battle = restore(state);
  return battle.choose(s === 0 ? "p1" : "p2", choice);
}
