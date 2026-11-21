import { STAT_IDS, type Evidence, type StatId } from "@ca/schema";
import { calcStat, natureEffect } from "@ca/calc";
import type { RuleContext } from "../context.js";
import type { FindingDraft, Rule } from "../rule.js";
import { clamp01 } from "../rule.js";

interface Benchmark {
  species: string;
  speed: number;
  label: "max" | "neutralMax";
}

/** Speed benchmarks: each legal species (and legal Mega forme) at max Speed, + / neutral nature. */
export function speedBenchmarks(ctx: RuleContext): Benchmark[] {
  const per = ctx.spec.statPoints.perStat.value;
  const formes = [...ctx.pack.legal.species];
  for (const base of ctx.pack.legal.megaSpecies) {
    for (const [item, evos] of ctx.dex.megaStones()) {
      if (!ctx.pack.legal.items.includes(item)) continue;
      for (const e of evos)
        if (e.baseId === base && ctx.dex.species(e.megaId)) formes.push(e.megaId);
    }
  }
  const out: Benchmark[] = [];
  for (const sp of [...new Set(formes)]) {
    let base: number;
    try {
      base = ctx.calc.baseStats(sp).spe;
    } catch {
      continue;
    }
    out.push({ species: sp, speed: calcStat(ctx.spec, "spe", base, per, "Timid"), label: "max" });
    out.push({
      species: sp,
      speed: calcStat(ctx.spec, "spe", base, per, "Hardy"),
      label: "neutralMax",
    });
  }
  return out.sort((a, b) => b.speed - a.speed || a.species.localeCompare(b.species));
}

/**
 * Members whose Speed sits just below a dense cluster of max-Speed benchmarks.
 * Suggestions are verified with calcStat: "+n SP outspeeds k more benchmarks".
 */
export const speedTierRule: Rule = {
  id: "speed.tiers",
  version: 1,
  category: "speedControl",
  params: ["window", "minPassed", "slowSpeed"],
  appliesTo: () => true,
  evaluate(ctx) {
    const bench = speedBenchmarks(ctx).filter((b) => b.label === "max");
    const window = ctx.param(this.id, "window");
    const minPassed = ctx.param(this.id, "minPassed");
    const slow = ctx.param(this.id, "slowSpeed");
    const per = ctx.spec.statPoints.perStat.value;
    const findings: FindingDraft[] = [];
    const scores: number[] = [];
    for (const m of ctx.team) {
      const mega = ctx.canMega(m);
      const forme = ctx.formeInBattle(m);
      const spe = ctx.stats(m, mega).spe;
      const faster = bench.filter((b) => b.speed > spe).length;
      scores.push(1 - faster / bench.length);
      if (spe <= slow) continue; // slow members are Trick Room candidates; not a tier problem
      // Deliberately slow (no Speed SP, or a Speed-lowering nature): don't suggest speeding up.
      if (m.sp.spe === 0 || natureEffect(m.nature, "spe") === -1) continue;
      const baseSpe = ctx.calc.baseStats(forme).spe;
      // Smallest SP increase that passes at least `minPassed` more max-Speed benchmarks within `window` SP.
      let best: { add: number; speed: number; passed: Benchmark[] } | undefined;
      for (let add = 1; add <= window && m.sp.spe + add <= per; add++) {
        const s = calcStat(ctx.spec, "spe", baseSpe, m.sp.spe + add, m.nature);
        const passed = bench.filter((b) => b.speed >= spe && b.speed < s && b.species !== forme);
        if (passed.length >= minPassed) {
          best = { add, speed: s, passed };
          break;
        }
      }
      if (!best) continue;
      const donors = STAT_IDS.filter((st) => st !== "spe" && m.sp[st] > 0) as StatId[];
      const free = ctx.freeSp(m);
      const evidence: Evidence = {
        kind: "calc",
        label: `すばやさ実数値（${mega ? "メガシンカ後" : "通常"}）と、参加可能ポケモンの最速値`,
        values: {
          species: forme,
          speed: spe,
          spSpe: m.sp.spe,
          newSp: m.sp.spe + best.add,
          newSpeed: best.speed,
          passedCount: best.passed.length,
          formula: "calcStat(spe)",
        },
      };
      const passedNames = best.passed.slice(0, 5).map((b) => b.species);
      findings.push({
        explainKey: "speed.nearTier",
        score: 0.7,
        params: {
          member: m.species,
          speed: spe,
          add: best.add,
          newSpeed: best.speed,
          passedCount: best.passed.length,
          examples: passedNames.join(","),
          free,
          donors: donors.join(","),
        },
        evidence: [
          evidence,
          {
            kind: "calc",
            label: "新たに抜ける相手（最速）",
            values: Object.fromEntries(best.passed.map((b) => [b.species, b.speed])),
          },
        ],
        suggestions: [
          {
            explainKey: free >= best.add ? "speed.suggest.free" : "speed.suggest.move",
            params: {
              member: m.species,
              add: best.add,
              newSpeed: best.speed,
              passedCount: best.passed.length,
              donors: donors.join(","),
            },
            evidence: [evidence],
          },
        ],
      });
    }
    return {
      score: clamp01(scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length)),
      findings,
    };
  },
};
