import type { PokemonSet } from "@ca/schema";
import { engineTags } from "@ca/data";
import { wilson } from "./game.js";
import { chooseFor, jointOptions, type JointOption } from "./policy.js";
import {
  restore,
  reseed,
  snap,
  type ReplayData,
  type ReplayTurn,
  type Snapshot,
  type WhatIfOption,
} from "./replay.js";
import { mixSeed, Rng } from "./rng.js";
import {
  markLogSent,
  playOut,
  startBattle,
  type BattleResult,
  type Config,
  type SimContext,
} from "./runner.js";
import type { PsBattle } from "./showdown.js";
import { parseLog } from "./trace.js";

export interface SearchOptions {
  /** candidate joint actions per side per turn (top by the heuristic) */
  options: number;
  /** simulated games per candidate ("thinking count") */
  rollouts: number;
}

export function searchOptionsFrom(params: Record<string, number>): SearchOptions {
  const o = params["searchOptions"];
  const r = params["searchRollouts"];
  if (o === undefined || r === undefined)
    throw new Error("weights.simulation.searchOptions / searchRollouts are missing");
  return { options: o, rollouts: r };
}

/**
 * Evaluate a side's candidate actions from a saved state: for each candidate, play `rollouts`
 * games from the state (the other side and later turns follow the heuristic policy) and
 * return the win rate from `side`'s point of view.
 */
export function evaluateCandidates(
  ctxIn: SimContext,
  state: Snapshot,
  side: 0 | 1,
  candidates: JointOption[],
  active: string[],
  rollouts: number,
  seed: number,
): WhatIfOption[] {
  // Playouts are symmetric: both sides use the same (lower) temperature so neither side's
  // evaluation is biased by a stronger/weaker continuation policy.
  const T = ctxIn.params["selfTemperature"] ?? ctxIn.params["temperature"];
  const ctx: SimContext = {
    ...ctxIn,
    params: { ...ctxIn.params, ...(T !== undefined ? { temperature: T } : {}) },
  };
  return candidates.map((c, i) => {
    let wins = 0;
    for (let k = 0; k < rollouts; k++) {
      const clone = restore(state);
      const rs = mixSeed(seed, side, i, k);
      reseed(clone, rs);
      if (!clone.choose(side === 0 ? "p1" : "p2", c.choice))
        clone.choose(side === 0 ? "p1" : "p2", "default");
      const r = playOut(ctx, clone, rs);
      wins += r.winner === side ? 1 : r.winner === null ? 0.5 : 0;
    }
    return {
      choice: c.choice,
      slots: c.slots.map((s, si) => ({
        species: active[si] ?? "",
        ...(s.moveId ? { moveId: s.moveId } : {}),
        ...(s.targetSpecies ? { targetSpecies: s.targetSpecies } : {}),
        mega: s.choice.endsWith(" mega"),
      })),
      winRate: wins / rollouts,
      games: rollouts,
      ci: wilson(wins, rollouts),
      chosen: false,
    };
  });
}

/** Highest win rate; ties go to the candidate the heuristic ranked higher (earlier). */
function pickBest(xs: WhatIfOption[]): number {
  let best = 0;
  xs.forEach((x, i) => {
    if (x.winRate > xs[best]!.winRate) best = i;
  });
  return best;
}

const needsMove = (b: PsBattle, i: 0 | 1) => {
  const r = b.sides[i].activeRequest;
  return !!r && !r.wait && !r.forceSwitch && !!r.active && !b.sides[i].isChoiceDone();
};

/**
 * "Best play" battle: every turn both sides evaluate their top candidates by rollouts from the
 * exact position and choose the highest win rate (simultaneously, from the same position).
 * Forced switches use the heuristic. Deterministic for a given seed.
 */
export function playBestBattle(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
  opts: SearchOptions,
  onProgress?: (turn: number) => void,
): ReplayData {
  const tags = engineTags();
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  const rng = new Rng(mixSeed(seed, 0xbe57));
  const mine = new Map<number, WhatIfOption[]>();
  const theirs = new Map<number, WhatIfOption[]>();
  let guard = 0;
  while (!battle.ended && battle.turn <= ctx.maxTurns && guard++ < ctx.maxTurns * 4) {
    markLogSent(battle);
    if (needsMove(battle, 0) && needsMove(battle, 1)) {
      const turn = battle.turn;
      onProgress?.(turn);
      const state = snap(battle);
      const evals = ([0, 1] as const).map((s) => {
        const side = battle.sides[s];
        const cands = jointOptions(battle, side, tags, ctx.params, opts.options);
        const active = side.active.map((m) => (m && !m.fainted ? m.species.id : ""));
        const ev = evaluateCandidates(
          ctx,
          state,
          s,
          cands,
          active,
          opts.rollouts,
          mixSeed(seed, 0x51, turn),
        );
        const best = pickBest(ev);
        ev[best]!.chosen = true;
        return ev;
      });
      mine.set(turn, evals[0]!);
      theirs.set(turn, evals[1]!);
      const choose = (s: 0 | 1) => {
        const c = evals[s]!.find((x) => x.chosen)!.choice;
        const id = s === 0 ? "p1" : "p2";
        if (!battle.choose(id, c)) battle.choose(id, "default");
      };
      choose(0);
      choose(1);
      continue;
    }
    for (const side of battle.sides) {
      if (battle.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
        continue;
      const choice = chooseFor(battle, side, tags, ctx.params, rng);
      if (!choice || !battle.choose(side.id, choice)) battle.choose(side.id, "default");
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
    const w = mine.get(t);
    const o = theirs.get(t);
    if (ev.length || w)
      turns.push({
        turn: t,
        events: ev,
        decisions: [],
        ...(w ? { whatIf: w } : {}),
        ...(o ? { whatIfOpp: o } : {}),
      });
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
    mode: "best",
  };
}
