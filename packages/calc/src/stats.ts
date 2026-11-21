import { Generations } from "@smogon/calc";
import { STAT_IDS, type GameSpec, type StatId, type StatsTable } from "@ca/schema";

export type NatureName = string;
const natures = Generations.get(9).natures;

/** +1 / -1 / 0 for the stat a nature raises/lowers. */
export function natureEffect(nature: NatureName, stat: StatId): 1 | -1 | 0 {
  const n = natures.get(nature.toLowerCase() as never);
  if (!n) throw new Error(`unknown nature "${nature}"`);
  if (n.plus === n.minus) return 0;
  if (n.plus === stat) return 1;
  if (n.minus === stat) return -1;
  return 0;
}

/** The nature that raises `up` and lowers `down` (both omitted → a neutral nature, "Serious"). */
export function natureFrom(up: StatId | undefined, down: StatId | undefined): NatureName {
  if (up === undefined && down === undefined) return "Serious";
  for (const n of natures) {
    if (n.plus === up && n.minus === down && n.plus !== n.minus) return n.name;
  }
  throw new Error(`no nature raises ${up ?? "-"} and lowers ${down ?? "-"}`);
}

/**
 * Champions stat formula — the single place it is implemented.
 * HP    = floor((2B + IV) * L / 100) + SP*k + L + 10
 * other = floor((floor((2B + IV) * L / 100) + SP*k + 5) * nature)
 * Verified against 36 in-game values (packages/calc/test/golden/ingame-stats.json).
 */
export function calcStat(
  spec: GameSpec,
  stat: StatId,
  base: number,
  sp: number,
  nature: NatureName,
): number {
  const L = spec.level.value;
  const inner =
    Math.floor(((2 * base + spec.iv.value) * L) / 100) + sp * spec.statPoints.statPerPoint.value;
  if (stat === "hp") {
    if (base === 1) return 1; // Shedinja
    return inner + L + 10;
  }
  const e = natureEffect(nature, stat);
  const mult =
    e === 1 ? spec.natureMultiplier.value.up : e === -1 ? spec.natureMultiplier.value.down : 1;
  // multiply in integer space to avoid 1.1 floating error (e.g. 160 * 1.1 = 176.00000000000003)
  return Math.floor(((inner + 5) * Math.round(mult * 100)) / 100);
}

export function calcStats(
  spec: GameSpec,
  base: StatsTable,
  sp: StatsTable,
  nature: NatureName,
): StatsTable {
  return Object.fromEntries(
    STAT_IDS.map((s) => [s, calcStat(spec, s, base[s], sp[s], nature)]),
  ) as StatsTable;
}

export interface SpreadIssue {
  stat?: StatId;
  message: string;
}

/** SP caps from the game spec. */
export function validateSp(spec: GameSpec, sp: StatsTable): SpreadIssue[] {
  const issues: SpreadIssue[] = [];
  const per = spec.statPoints.perStat.value;
  for (const s of STAT_IDS) {
    if (sp[s] < 0 || !Number.isInteger(sp[s]))
      issues.push({ stat: s, message: `SP must be a non-negative integer` });
    if (sp[s] > per)
      issues.push({ stat: s, message: `SP ${sp[s]} exceeds the per-stat cap ${per}` });
  }
  const total = STAT_IDS.reduce((a, s) => a + sp[s], 0);
  if (total > spec.statPoints.total.value) {
    issues.push({ message: `SP total ${total} exceeds the cap ${spec.statPoints.total.value}` });
  }
  return issues;
}

/** All SP values (0..perStat) that produce `observed`. Used to cross-check screenshots. */
export function inferSp(
  spec: GameSpec,
  stat: StatId,
  base: number,
  observed: number,
  nature: NatureName,
): number[] {
  const out: number[] = [];
  for (let sp = 0; sp <= spec.statPoints.perStat.value; sp++) {
    if (calcStat(spec, stat, base, sp, nature) === observed) out.push(sp);
  }
  return out;
}

/** EV value that reproduces `sp` in a Lv50 mainline formula (SP n ⇔ EV 8n-4; 32 ⇔ 252). */
export function spToEv(sp: number): number {
  return sp === 0 ? 0 : Math.min(252, sp * 8 - 4);
}
/** Inverse of {@link spToEv}; EV 252 → 32, EV 4 → 1, EV 0 → 0. */
export function evToSp(ev: number): number {
  return ev <= 0 ? 0 : Math.min(32, Math.floor((ev + 4) / 8));
}
