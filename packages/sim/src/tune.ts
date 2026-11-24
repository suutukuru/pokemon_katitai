// Improvement loop (ADR-0012): change one policy weight at a time and keep the change only when
// the changed policy beats the current one by a statistically clear margin in paired games
// (same teams, brings and seeds, played once from each side).
import type { PokemonSet } from "@ca/schema";
import type { PolicyParams } from "./policy.js";
import { mixSeed } from "./rng.js";
import { allConfigs, type Config } from "./runner.js";

export interface DuelJob {
  a: PokemonSet[];
  b: PokemonSet[];
  ca: Config;
  cb: Config;
  seed: number;
  params: [PolicyParams, PolicyParams];
}
/** Runs duels (in-process or in parallel); returns side A's score per job, in order. */
export type DuelRunner = (jobs: DuelJob[]) => Promise<number[]>;

export interface TuneStep {
  key: string;
  from: number;
  to: number;
  /** challenger's mean score over paired games (0.5 = no difference) */
  score: number;
  /** standard error of `score` over pairs */
  se: number;
  games: number;
  accepted: boolean;
}

export interface TuneOptions {
  /** games per candidate value (rounded up to whole pairs) */
  games: number;
  /** relative change tried in each direction */
  step: number;
  /** acceptance threshold in standard errors */
  z: number;
  seed: number;
  bring: number;
  /** games for the final held-out check of all accepted changes together (0 = skip) */
  validate?: number;
}

/** Paired games: every matchup is played with the challenger on each side, same seed. */
export function pairedJobs(
  teams: PokemonSet[][],
  challenger: PolicyParams,
  incumbent: PolicyParams,
  games: number,
  seed: number,
  bring: number,
): DuelJob[] {
  const jobs: DuelJob[] = [];
  const pairs = Math.max(1, Math.ceil(games / 2));
  const matchups: [number, number][] = [];
  teams.forEach((_, i) => teams.forEach((_, j) => i !== j && matchups.push([i, j])));
  for (let k = 0; k < pairs; k++) {
    const [i, j] = matchups[k % matchups.length]!;
    const A = teams[i]!;
    const B = teams[j]!;
    const ca = allConfigs(A.length, Math.min(bring, A.length));
    const cb = allConfigs(B.length, Math.min(bring, B.length));
    const s = mixSeed(seed, k);
    const x = ca[s % ca.length]!;
    const y = cb[mixSeed(s, 1) % cb.length]!;
    jobs.push({ a: A, b: B, ca: x, cb: y, seed: s, params: [challenger, incumbent] });
    jobs.push({ a: A, b: B, ca: x, cb: y, seed: s, params: [incumbent, challenger] });
  }
  return jobs;
}

/** Challenger's score and its standard error from paired results (A-score per job). */
export function pairedScore(results: number[]): { score: number; se: number } {
  const pairs: number[] = [];
  for (let i = 0; i + 1 < results.length; i += 2)
    pairs.push((results[i]! + (1 - results[i + 1]!)) / 2);
  const n = pairs.length;
  const mean = pairs.reduce((a, x) => a + x, 0) / Math.max(1, n);
  const v = pairs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1);
  return { score: mean, se: Math.sqrt(v / Math.max(1, n)) };
}

/** Coordinate search over `keys`. Deterministic for a given seed. */
export async function tunePolicy(
  base: PolicyParams,
  keys: string[],
  teams: PokemonSet[][],
  run: DuelRunner,
  o: TuneOptions,
  onStep?: (s: TuneStep) => void,
): Promise<{ params: PolicyParams; steps: TuneStep[]; validation?: TuneStep }> {
  let params = { ...base };
  const steps: TuneStep[] = [];
  for (const [ki, key] of keys.entries()) {
    const v = params[key];
    if (v === undefined) continue;
    const tries = v === 0 ? [0.1, -0.1] : [v * (1 + o.step), v * (1 - o.step)];
    for (const [ti, to] of tries.entries()) {
      const challenger = { ...params, [key]: Math.round(to * 1000) / 1000 };
      const jobs = pairedJobs(teams, challenger, params, o.games, mixSeed(o.seed, ki, ti), o.bring);
      const { score, se } = pairedScore(await run(jobs));
      const accepted = score > 0.5 && score - 0.5 > o.z * se;
      const st: TuneStep = {
        key,
        from: v,
        to: challenger[key]!,
        score,
        se,
        games: jobs.length,
        accepted,
      };
      steps.push(st);
      onStep?.(st);
      if (accepted) {
        params = challenger;
        break; // keep this direction; move on to the next weight
      }
    }
  }
  // Many tries at a fixed threshold produce chance winners: re-check everything accepted
  // together against the starting weights on seeds that were never used above.
  const changed = Object.keys(params).filter((k) => params[k] !== base[k]);
  if (changed.length === 0 || !o.validate) return { params, steps };
  const jobs = pairedJobs(teams, params, base, o.validate, mixSeed(o.seed, 0x7a11d), o.bring);
  const { score, se } = pairedScore(await run(jobs));
  const ok = score > 0.5 && score - 0.5 > o.z * se;
  const validation: TuneStep = {
    key: changed.join("+"),
    from: 0,
    to: 0,
    score,
    se,
    games: jobs.length,
    accepted: ok,
  };
  onStep?.(validation);
  return { params: ok ? params : { ...base }, steps, validation };
}

/** Policy weights that the tuner may change (all in weights.json `simulation`). */
export const TUNABLE = [
  "koBonus",
  "koFirstDiscount",
  "koFirstBonus",
  "protectBase",
  "protectThreatBonus",
  "protectFirstHitBonus",
  "protectRepeatPenalty",
  "switchBase",
  "switchThreatBonus",
  "switchMatchupWeight",
  "fakeOutValue",
  "tailwindValue",
  "trickRoomValue",
  "setupValue",
  "allyHitPenalty",
  "speedDropBonus",
  "redirectionValue",
  "statusMoveValue",
  "sleepValue",
  "screenValue",
] as const;
