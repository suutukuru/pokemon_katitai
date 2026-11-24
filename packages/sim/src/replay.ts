import type { PokemonSet } from "@ca/schema";
import { engineTags } from "@ca/data";
import { chooseFor, jointOptions, type DecisionTrace } from "./policy.js";
import { mixSeed, Rng } from "./rng.js";
import {
  markLogSent,
  playOut,
  startBattle,
  type BattleResult,
  type Config,
  type SimContext,
} from "./runner.js";
import { Battle, type PsBattle } from "./showdown.js";
import { parseLog, type BattleEvent } from "./trace.js";
import { wilson } from "./game.js";
import type { DecisionReview } from "./reflection.js";

/**
 * Saved battle state as a JSON string. Showdown's toJSON() shares arrays (e.g. the log) with the
 * live battle, so the snapshot is serialized immediately and every restore parses a fresh copy.
 */
export type Snapshot = string;
export const snap = (b: PsBattle): Snapshot =>
  JSON.stringify((b as unknown as { toJSON(): unknown }).toJSON());
export const restore = (s: Snapshot): PsBattle => {
  const b = (Battle as unknown as { fromJSON(x: unknown): PsBattle }).fromJSON(JSON.parse(s));
  markLogSent(b);
  return b;
};
export const reseed = (b: PsBattle, seed: number) =>
  (b as unknown as { resetRNG(s: [number, number, number, number]): void }).resetRNG([
    seed & 0xffff,
    (seed >>> 16) & 0xffff,
    0x2468,
    0x1357,
  ]);

export interface WhatIfOption {
  choice: string;
  slots: {
    species: string;
    moveId?: string;
    targetSpecies?: string;
    switchTo?: string;
    mega: boolean;
  }[];
  winRate: number;
  games: number;
  ci: [number, number];
  chosen: boolean;
  /** equilibrium probability (search mode) */
  prob?: number;
  /** win rate against the other side's worst reply for this side (search mode) */
  worst?: number;
  /** false = dropped while pruning (value is against the policy, not the equilibrium) */
  inMatrix?: boolean;
}

export interface ReplayTurn {
  turn: number;
  events: BattleEvent[];
  decisions: DecisionTrace[];
  /** My side's alternatives at this turn, evaluated by rollouts from the exact state. */
  whatIf?: WhatIfOption[];
  /** The opponent's alternatives (win rate from the opponent's point of view), in best-play mode. */
  whatIfOpp?: WhatIfOption[];
  /** my win rate at this turn's equilibrium (search mode): the position's evaluation */
  eval?: number;
  /** forced switch-ins decided after this turn's moves (search mode), per side */
  switchIf?: { side: 0 | 1; options: WhatIfOption[] }[];
}

export interface ReplayData {
  seed: number;
  result: BattleResult;
  brought: [string[], string[]];
  /** max HP and display info per brought Pokémon (side, species) */
  members: { side: 0 | 1; species: string; maxhp: number; item?: string }[];
  turns: ReplayTurn[];
  rollouts: number;
  /** per-decision reviews (expected vs what was achievable once the opponent's move was known) */
  reviews?: DecisionReview[];
  /** true when each side planned from its own view (hidden information sampled) */
  planner?: boolean;
  /** "sampled": AI policy game with what-if analysis; "best": both sides pick their highest win-rate action. */
  mode?: "sampled" | "best";
}

/**
 * Play one battle and, at each of my turns, evaluate the top alternatives (plus the move actually
 * taken) by `rollouts` simulations from that exact state — a shogi-style "what if" analysis.
 */
export function analyzeReplay(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
  opts: { options: number; rollouts: number },
  onProgress?: (turn: number) => void,
): ReplayData {
  const tags = engineTags();
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  const rng = new Rng(mixSeed(seed, 0xbeef));
  const decisions: DecisionTrace[] = [];
  const whatIf = new Map<number, WhatIfOption[]>();
  let guard = 0;
  while (!battle.ended && battle.turn <= ctx.maxTurns && guard++ < ctx.maxTurns * 4) {
    markLogSent(battle);
    const p1 = battle.sides[0];
    const req = p1.activeRequest;
    let state: Snapshot | undefined;
    let candidates: ReturnType<typeof jointOptions> = [];
    let active: string[] = [];
    if (req && !req.wait && !req.forceSwitch && !p1.isChoiceDone() && req.active) {
      state = snap(battle);
      active = p1.active.map((m) => (m && !m.fainted ? m.species.id : ""));
      candidates = jointOptions(battle, p1, tags, ctx.params, opts.options);
    }
    let myChoice = "";
    for (const side of battle.sides) {
      if (battle.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
        continue;
      const choice = chooseFor(battle, side, tags, ctx.params, rng, decisions);
      if (side.id === "p1") myChoice = choice;
      if (!choice || !battle.choose(side.id, choice)) battle.choose(side.id, "default");
    }
    if (state !== undefined && myChoice) {
      const turn = decisions.filter((d) => d.side === 0).at(-1)?.turn ?? battle.turn - 1;
      onProgress?.(turn);
      const list = candidates.map((c) => ({ choice: c.choice, slots: c.slots }));
      if (!list.some((c) => c.choice === myChoice)) {
        list.push({ choice: myChoice, slots: [] });
      }
      whatIf.set(
        turn,
        list.map((c, i) => {
          let wins = 0;
          for (let k = 0; k < opts.rollouts; k++) {
            const clone = restore(state);
            const rs = mixSeed(seed, 0x77, turn, i, k);
            reseed(clone, rs);
            if (!clone.choose("p1", c.choice)) clone.choose("p1", "default");
            const r = playOut(ctx, clone, rs);
            wins += r.winner === 0 ? 1 : r.winner === null ? 0.5 : 0;
          }
          return {
            choice: c.choice,
            slots: c.slots.length
              ? c.slots.map((s, si) => ({
                  species: active[si] ?? "",
                  ...(s.moveId ? { moveId: s.moveId } : {}),
                  ...(s.targetSpecies ? { targetSpecies: s.targetSpecies } : {}),
                  mega: s.choice.endsWith(" mega"),
                }))
              : decisions
                  .filter((d) => d.side === 0 && d.turn === turn)
                  .map((d) => {
                    const o = d.options[d.chosen]!.option;
                    return {
                      species: d.species,
                      ...(o.moveId ? { moveId: o.moveId } : {}),
                      ...(o.targetSpecies ? { targetSpecies: o.targetSpecies } : {}),
                      mega: o.choice.endsWith(" mega"),
                    };
                  }),
            winRate: wins / opts.rollouts,
            games: opts.rollouts,
            ci: wilson(wins, opts.rollouts),
            chosen: c.choice === myChoice,
          };
        }),
      );
    }
  }
  const left = (i: 0 | 1) => battle.sides[i].pokemon.filter((x) => !x.fainted && x.hp > 0).length;
  const result: BattleResult = {
    winner: !battle.ended ? null : battle.winner === "A" ? 0 : battle.winner === "B" ? 1 : null,
    turns: battle.turn,
    remaining: [left(0), left(1)],
  };
  const events = parseLog(battle);
  const maxTurn = Math.max(battle.turn, ...events.keys());
  const turns: ReplayTurn[] = [];
  for (let t = 0; t <= maxTurn; t++) {
    const ev = events.get(t) ?? [];
    const d = decisions.filter((x) => x.turn === t);
    const w = whatIf.get(t);
    if (ev.length || d.length)
      turns.push({ turn: t, events: ev, decisions: d, ...(w ? { whatIf: w } : {}) });
  }
  const members = ([0, 1] as const).flatMap((side) =>
    (side === 0 ? ca : cb).map((i) => {
      const set = (side === 0 ? a : b)[i]!;
      const mon = battle.sides[side].pokemon.find(
        (p) => (p as unknown as { set: { species: string } }).set.species === set.species,
      );
      return {
        side,
        species: set.species,
        maxhp: mon?.maxhp ?? 0,
        ...(set.item ? { item: set.item } : {}),
      };
    }),
  );
  return {
    seed,
    result,
    brought: [ca.map((i) => a[i]!.species), cb.map((i) => b[i]!.species)],
    members,
    turns,
    rollouts: opts.rollouts,
  };
}
