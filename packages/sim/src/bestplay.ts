import type { PokemonSet } from "@ca/schema";
import { engineTags } from "@ca/data";
import { wilson } from "./game.js";
import { chooseFor, searchCandidates, type JointOption } from "./policy.js";
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
  /** joint candidates kept from the heuristic ranking (plus every single-slot option's best completion) */
  options: number;
  /** successive halving: rollouts per candidate in each stage and how many survive to the next */
  stages: { rollouts: number; keep: number }[];
}

/** Read the search budget from weights.json `simulation` (searchWidth, searchStageN / searchKeepN). */
export function searchOptionsFrom(params: Record<string, number>, scale = 1): SearchOptions {
  const req = (k: string) => {
    const v = params[k];
    if (v === undefined) throw new Error(`weights.simulation.${k} is missing`);
    return v;
  };
  const stages: { rollouts: number; keep: number }[] = [];
  for (let i = 1; params[`searchStage${i}`] !== undefined; i++) {
    stages.push({
      rollouts: Math.max(1, Math.round(req(`searchStage${i}`) * scale)),
      keep: params[`searchKeep${i}`] ?? 1,
    });
  }
  if (stages.length === 0) throw new Error("weights.simulation.searchStage1 is missing");
  return { options: req("searchWidth"), stages };
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
  offset = 0,
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
      const rs = mixSeed(seed, side, i, k + offset);
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

/**
 * Successive halving: every candidate gets stage-1 rollouts, the best `keep` get more, and so on.
 * Each result accumulates all its games; `stage` tells how far it survived.
 */
export function successiveHalving(
  ctx: SimContext,
  state: Snapshot,
  side: 0 | 1,
  cands: JointOption[],
  active: string[],
  opts: SearchOptions,
  seed: number,
): (WhatIfOption & { stage: number })[] {
  const acc = new Map<string, { opt: WhatIfOption; wins: number; games: number; stage: number }>();
  let alive = cands;
  let offset = 0;
  opts.stages.forEach((st, si) => {
    const ev = evaluateCandidates(
      ctx,
      state,
      side,
      alive,
      active,
      st.rollouts,
      mixSeed(seed, si),
      offset,
    );
    offset += st.rollouts;
    ev.forEach((e) => {
      const a = acc.get(e.choice) ?? { opt: e, wins: 0, games: 0, stage: 0 };
      a.wins += e.winRate * e.games;
      a.games += e.games;
      a.stage = si + 1;
      acc.set(e.choice, a);
    });
    const ranked = alive
      .map((c) => ({ c, a: acc.get(c.choice)! }))
      .sort((x, y) => y.a.wins / y.a.games - x.a.wins / x.a.games);
    alive = ranked.slice(0, st.keep).map((x) => x.c);
  });
  return [...acc.values()].map((a) => ({
    ...a.opt,
    winRate: a.wins / a.games,
    games: a.games,
    ci: wilson(a.wins, a.games),
    chosen: false,
    stage: a.stage,
  }));
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
        const cands = searchCandidates(battle, side, tags, ctx.params, opts.options);
        const active = side.active.map((m) => (m && !m.fainted ? m.species.id : ""));
        const ev = successiveHalving(ctx, state, s, cands, active, opts, mixSeed(seed, 0x51, turn));
        const finalists = ev.filter((x) => x.stage === opts.stages.length);
        const best = finalists[pickBest(finalists)]!;
        best.chosen = true;
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
    rollouts: opts.stages.reduce((x, st) => x + st.rollouts, 0),
    mode: "best",
  };
}
