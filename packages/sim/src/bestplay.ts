import type { PokemonSet } from "@ca/schema";
import { engineTags } from "@ca/data";
import { wilson } from "./game.js";
import { chooseFor } from "./policy.js";
import {
  snap,
  type ReplayData,
  type ReplayTurn,
  type TurnPlan,
  type WhatIfOption,
} from "./replay.js";
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
import type { Prior } from "./belief.js";
import { reviewDecision, type DecisionReview } from "./reflection.js";

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
  opts: {
    /** with a prior, each side plans from its own view (hidden information sampled) */
    prior?: Prior;
    onProgress?: (turn: number, analysis: PositionAnalysis) => void;
  } = {},
): Promise<ReplayData> {
  const onProgress = opts.onProgress;
  const tags = engineTags();
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  const rng = new Rng(mixSeed(seed, 0xbe57));
  const moves = new Map<number, PositionAnalysis>();
  const boards = new Map<number, TurnPlan["board"]>();
  const oppMoves = new Map<number, PositionAnalysis>();
  const reviews: DecisionReview[] = [];
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
    const st = snap(battle);
    const sd = mixSeed(seed, 0x51, turn, guard);
    // per side: the analysis it decides with (its own view when a prior is given)
    const views: [PositionAnalysis | null, PositionAnalysis | null] = [null, null];
    if (opts.prior) {
      for (const s of [0, 1] as const)
        if (need[s])
          views[s] = await analyzePosition(ctx, st, exec, budget, mixSeed(sd, s), {
            viewer: s,
            prior: opts.prior,
          });
    } else {
      const an = await analyzePosition(ctx, st, exec, budget, sd);
      views[0] = need[0] ? an : null;
      views[1] = need[1] ? an : null;
    }
    const shown = views[0] ?? views[1]!;
    rollouts +=
      (views[0]?.rollouts ?? 0) + (views[1] && views[1] !== views[0] ? views[1].rollouts : 0);
    onProgress?.(turn, shown);
    const choice: [string, string] = [
      views[0] ? bestChoice(views[0], 0) : "",
      views[1] ? bestChoice(views[1], 1) : "",
    ];
    for (const s of [0, 1] as const)
      if (views[s]) reviews.push(reviewDecision(ctx, st, views[s]!, s, choice[s], choice[1 - s]!));
    if (shown.kind === "move") {
      moves.set(turn, views[0] ?? shown);
      boards.set(
        turn,
        battle.sides.flatMap((side, si) =>
          side.pokemon.map((m) => ({
            side: si as 0 | 1,
            species: m.species.id,
            hp: m.maxhp ? Math.round((m.hp / m.maxhp) * 100) : 0,
            status: m.fainted ? "fnt" : m.status,
            active: side.active.includes(m) && !m.fainted,
          })),
        ),
      );
      if (views[1]) oppMoves.set(turn, views[1]);
    } else
      switches.set(turn, [
        ...(switches.get(turn) ?? []),
        ...([views[0], views[1]].filter(
          (x, i) => x && (i === 0 || x !== views[0]),
        ) as PositionAnalysis[]),
      ]);
    for (const s of [0, 1] as const) {
      if (!need[s]) continue;
      const id = s === 0 ? "p1" : "p2";
      if (!choice[s] || !battle.choose(id, choice[s])) battle.choose(id, "default");
    }
  }
  const final = resultOf(battle);
  for (const r of reviews)
    r.outcome = final.winner === null ? 0.5 : final.winner === r.side ? 1 : 0;
  const events = parseLog(battle);
  const maxTurn = Math.max(battle.turn, ...events.keys());
  const turns: ReplayTurn[] = [];
  for (let t = 0; t <= maxTurn; t++) {
    const ev = events.get(t) ?? [];
    const mv = moves.get(t);
    const om = oppMoves.get(t) ?? mv;
    // Showdown asks for forced switch-ins before it starts the next turn, so they share turn t.
    const sw = switches.get(t);
    if (!ev.length && !mv && !sw) continue;
    const opts = (an: PositionAnalysis, s: 0 | 1) => {
      // in planner mode a side's own options come from its own analysis
      if (an.viewer !== null && an.viewer !== s) return [];
      const c = bestChoice(an, s);
      return an.options[s].map((o) => toWhatIf(o, o.choice === c));
    };
    turns.push({
      turn: t,
      events: ev,
      decisions: [],
      ...(mv && mv.needs[0] ? { whatIf: opts(mv, 0) } : {}),
      ...(om && om.needs[1] ? { whatIfOpp: opts(om, 1) } : {}),
      ...(mv ? { eval: mv.value } : {}),
      ...(mv && mv.needs[0]
        ? {
            plan: {
              board: boards.get(t) ?? [],
              mine: mv.options[0].map((o) => toWhatIf(o, o.choice === bestChoice(mv, 0))),
              opp: mv.options[1].map((o) => toWhatIf(o, false)),
              rows: mv.matrixChoices[0],
              cols: mv.matrixChoices[1],
              matrix: mv.matrix.map((r) => r.map((v) => Math.round(v * 1000) / 1000)),
              worlds: mv.worlds,
              rollouts: mv.rollouts,
            },
          }
        : {}),
      ...(sw
        ? {
            switchIf: sw.flatMap((an) =>
              ([0, 1] as const)
                .filter(
                  (s) =>
                    an.needs[s] &&
                    an.options[s].length > 1 &&
                    (an.viewer === null || an.viewer === s),
                )
                .map((s) => ({ side: s, options: opts(an, s) })),
            ),
          }
        : {}),
    });
  }
  return {
    seed,
    result: final,
    reviews: reviews.filter((r) => r.turn >= 0),
    planner: !!opts.prior,
    brought: [ca.map((i) => a[i]!.species), cb.map((i) => b[i]!.species)],
    members: replayMembers(battle, a, b, ca, cb),
    turns,
    rollouts,
    mode: "best",
  };
}
