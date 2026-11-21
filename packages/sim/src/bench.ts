import type { PokemonSet } from "@ca/schema";
import { wilson } from "./game.js";
import type { PolicyParams } from "./policy.js";
import { mixSeed, Rng } from "./rng.js";
import { allConfigs, simulate, type SimContext } from "./runner.js";

export interface BenchResult {
  /** games won by policy X (draws count half) */
  wins: number;
  games: number;
  rate: number;
  ci: [number, number];
}

/**
 * Policy strength check: policy X vs policy Y on the same pair of teams. Every game is played
 * twice with the teams swapped between the policies (and the same random brings), so team
 * strength cancels out. Both policies play at the same temperature (no p1 advantage).
 */
export function benchPolicies(
  ctx: SimContext,
  teamA: readonly PokemonSet[],
  teamB: readonly PokemonSet[],
  x: PolicyParams,
  y: PolicyParams,
  pairs: number,
  seed: number,
): BenchResult {
  const even = (q: PolicyParams): PolicyParams => {
    const { selfTemperature: _s, ...rest } = q;
    return {
      ...rest,
      ...(q["selfTemperature"] !== undefined ? { temperature: q["selfTemperature"] } : {}),
    };
  };
  const px = even(x);
  const py = even(y);
  const bring = ctx.pack.rules.bringCount;
  const ca = allConfigs(teamA.length, Math.min(bring, teamA.length));
  const cb = allConfigs(teamB.length, Math.min(bring, teamB.length));
  const rng = new Rng(mixSeed(seed, 0xb3));
  let wins = 0;
  for (let k = 0; k < pairs; k++) {
    const a = ca[Math.floor(rng.next() * ca.length)]!;
    const b = cb[Math.floor(rng.next() * cb.length)]!;
    const s = mixSeed(seed, k);
    const r1 = simulate({ ...ctx, sideParams: [px, py] }, teamA, teamB, a, b, s);
    const r2 = simulate({ ...ctx, sideParams: [py, px] }, teamA, teamB, a, b, s);
    wins += r1.winner === 0 ? 1 : r1.winner === null ? 0.5 : 0;
    wins += r2.winner === 1 ? 1 : r2.winner === null ? 0.5 : 0;
  }
  const games = pairs * 2;
  return { wins, games, rate: wins / games, ci: wilson(wins, games) };
}
