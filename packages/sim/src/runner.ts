import type { GameSpec, PokemonSet, ResolvedPack } from "@ca/schema";
import { engineTags } from "@ca/data";
import {
  chooseFor,
  jointOptions,
  type DecisionTrace,
  type JointOption,
  type PolicyParams,
} from "./policy.js";
import { mixSeed, Rng } from "./rng.js";
import { Battle, toShowdownSet, type PsBattle } from "./showdown.js";

/** A bring: 4 team indices (0-based); the first two lead. */
export type Config = [number, number, number, number];

export interface SimContext {
  pack: ResolvedPack;
  spec: GameSpec;
  format: string;
  params: PolicyParams;
  maxTurns: number;
}

export function simContext(pack: ResolvedPack, spec: GameSpec): SimContext {
  const sim = pack.rules.simulator;
  if (!sim) throw new Error(`rules.simulator is not configured for ${pack.id}`);
  return {
    pack,
    spec,
    format: sim.format,
    params: pack.weights.simulation,
    maxTurns: pack.weights.simulation["maxTurns"] ?? 60,
  };
}

export interface BattleResult {
  /** 0 = side A (mine) won, 1 = side B won, null = draw / turn limit */
  winner: 0 | 1 | null;
  turns: number;
  /** Remaining Pokémon (not fainted) per side at the end. */
  remaining: [number, number];
}

function newBattle(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  seed: number,
): PsBattle {
  const battle = new Battle({
    formatid: ctx.format,
    seed: [seed & 0xffff, (seed >>> 16) & 0xffff, 0x1234, 0x5678],
  });
  const lvl = ctx.pack.rules.level;
  const iv = ctx.spec.iv.value;
  battle.setPlayer("p1", { name: "A", team: a.map((s) => toShowdownSet(s, iv, lvl)) });
  battle.setPlayer("p2", { name: "B", team: b.map((s) => toShowdownSet(s, iv, lvl)) });
  return battle;
}

const teamChoice = (c: Config) => `team ${c.map((i) => i + 1).join("")}`;

/** Start a battle and play team preview; returns the battle at the first move request. */
export function startBattle(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
): PsBattle {
  const battle = newBattle(ctx, a, b, seed);
  battle.choose("p1", teamChoice(ca));
  battle.choose("p2", teamChoice(cb));
  return battle;
}

/** Play the battle to the end with the heuristic policy on both sides. */
export function playOut(
  ctx: SimContext,
  battle: PsBattle,
  seed: number,
  trace?: DecisionTrace[],
): BattleResult {
  const tags = engineTags();
  const rng = new Rng(mixSeed(seed, 0xbeef));
  let guard = 0;
  while (!battle.ended && battle.turn <= ctx.maxTurns && guard++ < ctx.maxTurns * 4) {
    for (const side of battle.sides) {
      if (battle.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
        continue;
      const choice = chooseFor(battle, side, tags, ctx.params, rng, trace);
      if (!choice || !battle.choose(side.id, choice)) battle.choose(side.id, "default");
    }
  }
  const left = (i: 0 | 1) => battle.sides[i].pokemon.filter((x) => !x.fainted && x.hp > 0).length;
  const winner = !battle.ended
    ? null
    : battle.winner === "A"
      ? 0
      : battle.winner === "B"
        ? 1
        : null;
  return { winner, turns: battle.turn, remaining: [left(0), left(1)] };
}

export function simulate(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
): BattleResult {
  return playOut(ctx, startBattle(ctx, a, b, ca, cb, seed), seed);
}

/** Turn-1 joint options of both sides for a fixed pair of configs. */
export function turnOneOptions(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  limit: number,
): [JointOption[], JointOption[]] {
  const battle = startBattle(ctx, a, b, ca, cb, 1);
  const tags = engineTags();
  return [
    jointOptions(battle, battle.sides[0], tags, ctx.params, limit),
    jointOptions(battle, battle.sides[1], tags, ctx.params, limit),
  ];
}

/** Simulate with both sides' turn-1 choices forced, then the policy plays on. */
export function simulateForced(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  choiceA: string,
  choiceB: string,
  seed: number,
): BattleResult {
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  if (!battle.choose("p1", choiceA)) battle.choose("p1", "default");
  if (!battle.choose("p2", choiceB)) battle.choose("p2", "default");
  return playOut(ctx, battle, seed);
}

/** All brings: C(n,4) × C(4,2) lead pairs (lead order within the pair and back order are ignored). */
export function allConfigs(n: number, bring = 4): Config[] {
  const out: Config[] = [];
  const idx = [...Array(n).keys()];
  const combos = (xs: number[], k: number): number[][] =>
    k === 0
      ? [[]]
      : xs.length < k
        ? []
        : [...combos(xs.slice(1), k - 1).map((c) => [xs[0]!, ...c]), ...combos(xs.slice(1), k)];
  for (const four of combos(idx, bring)) {
    for (const lead of combos(four, 2)) {
      const back = four.filter((x) => !lead.includes(x));
      out.push([lead[0]!, lead[1]!, back[0]!, back[1]!]);
    }
  }
  return out;
}
