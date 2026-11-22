import type { PokemonSet } from "@ca/schema";
import { engineTags } from "@ca/data";
import { wilson } from "./game.js";
import { chooseFor } from "./policy.js";
import { snap, type ReplayData, type ReplayTurn, type WhatIfOption } from "./replay.js";
import { mixSeed, Rng } from "./rng.js";
import {
  markLogSent,
  startBattle,
  type BattleResult,
  type Config,
  type SimContext,
} from "./runner.js";
import {
  analyzePosition,
  bestChoice,
  inProcessRollouts,
  type PositionAnalysis,
  type RolloutExecutor,
  type SearchBudget,
  type SearchOption,
} from "./search.js";
import type { PsBattle } from "./showdown.js";
import { parseLog } from "./trace.js";

export function toWhatIf(o: SearchOption, chosen: boolean): WhatIfOption {
  return {
    choice: o.choice,
    slots: o.slots,
    winRate: o.value,
    games: o.games,
    ci: wilson(o.value * o.games, o.games),
    chosen,
    prob: o.prob,
    worst: o.worst,
    inMatrix: o.inMatrix,
  };
}

const needsChoice = (b: PsBattle, i: 0 | 1) => {
  const side = b.sides[i];
  const r = side.activeRequest;
  return !!r && !r.wait && !side.isChoiceDone() && (!!r.forceSwitch || !!r.active);
};

/** Members' display info for a replay. */
export function replayMembers(
  battle: PsBattle,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
): ReplayData["members"] {
  return ([0, 1] as const).flatMap((side) =>
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
}

export function resultOf(battle: PsBattle): BattleResult {
  const left = (i: 0 | 1) => battle.sides[i].pokemon.filter((x) => !x.fainted && x.hp > 0).length;
  return {
    winner: !battle.ended ? null : battle.winner === "A" ? 0 : battle.winner === "B" ? 1 : null,
    turns: battle.turn,
    remaining: [left(0), left(1)],
  };
}

/**
 * "Best play" battle: at every decision (moves and forced switch-ins) both sides' options are
 * evaluated together as a simultaneous-move game (search.ts) and each side plays its
 * equilibrium's most likely action. Deterministic for a given seed and budget.
 */
export async function playBestBattle(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
  budget: SearchBudget,
  exec: RolloutExecutor = inProcessRollouts(ctx),
  onProgress?: (turn: number, analysis: PositionAnalysis) => void,
): Promise<ReplayData> {
  const tags = engineTags();
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  const rng = new Rng(mixSeed(seed, 0xbe57));
  const moves = new Map<number, PositionAnalysis>();
  const switches = new Map<number, PositionAnalysis[]>();
  let guard = 0;
  let rollouts = 0;
  while (!battle.ended && battle.turn <= ctx.maxTurns && guard++ < ctx.maxTurns * 4) {
    markLogSent(battle);
    const need = [needsChoice(battle, 0), needsChoice(battle, 1)] as const;
    if (!need[0] && !need[1]) {
      // nothing to decide (should not happen); let the policy unblock
      for (const side of battle.sides) {
        const c = chooseFor(battle, side, tags, ctx.params, rng);
        if (c) battle.choose(side.id, c);
      }
      continue;
    }
    const turn = battle.turn;
    const an = await analyzePosition(
      ctx,
      snap(battle),
      exec,
      budget,
      mixSeed(seed, 0x51, turn, guard),
    );
    rollouts += an.rollouts;
    onProgress?.(turn, an);
    if (an.kind === "move") moves.set(turn, an);
    else switches.set(turn, [...(switches.get(turn) ?? []), an]);
    for (const s of [0, 1] as const) {
      if (!an.needs[s]) continue;
      const id = s === 0 ? "p1" : "p2";
      const c = bestChoice(an, s);
      if (!c || !battle.choose(id, c)) battle.choose(id, "default");
    }
  }
  const events = parseLog(battle);
  const maxTurn = Math.max(battle.turn, ...events.keys());
  const turns: ReplayTurn[] = [];
  for (let t = 0; t <= maxTurn; t++) {
    const ev = events.get(t) ?? [];
    const mv = moves.get(t);
    // Showdown asks for forced switch-ins before it starts the next turn, so they share turn t.
    const sw = switches.get(t);
    if (!ev.length && !mv && !sw) continue;
    const opts = (an: PositionAnalysis, s: 0 | 1) => {
      const c = bestChoice(an, s);
      return an.options[s].map((o) => toWhatIf(o, o.choice === c));
    };
    turns.push({
      turn: t,
      events: ev,
      decisions: [],
      ...(mv && mv.needs[0] ? { whatIf: opts(mv, 0) } : {}),
      ...(mv && mv.needs[1] ? { whatIfOpp: opts(mv, 1) } : {}),
      ...(mv ? { eval: mv.value } : {}),
      ...(sw
        ? {
            switchIf: sw.flatMap((an) =>
              ([0, 1] as const)
                .filter((s) => an.needs[s] && an.options[s].length > 1)
                .map((s) => ({ side: s, options: opts(an, s) })),
            ),
          }
        : {}),
    });
  }
  return {
    seed,
    result: resultOf(battle),
    brought: [ca.map((i) => a[i]!.species), cb.map((i) => b[i]!.species)],
    members: replayMembers(battle, a, b, ca, cb),
    turns,
    rollouts,
    mode: "best",
  };
}
