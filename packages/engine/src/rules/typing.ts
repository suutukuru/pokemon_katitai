import type { Evidence } from "@ca/schema";
import { ATTACK_TYPES } from "../context.js";
import type { FindingDraft, Rule } from "../rule.js";
import { clamp01, ids } from "../rule.js";

/** Attacking types that hit many members super-effectively while few resist. */
export const sharedWeaknessRule: Rule = {
  id: "defense.sharedWeakness",
  version: 1,
  category: "defensiveSynergy",
  params: ["weakMin", "resistMax", "penaltyPerType", "quadPenalty"],
  appliesTo: () => true,
  evaluate(ctx) {
    const weakMin = ctx.param(this.id, "weakMin");
    const resistMax = ctx.param(this.id, "resistMax");
    const findings: FindingDraft[] = [];
    let penalty = 0;
    const quad: string[] = [];
    for (const type of ATTACK_TYPES) {
      const eff = ctx.team.map((m) => ({
        m,
        e: ctx.effectiveness(type, ctx.formeInBattle(m), ctx.abilities(m)),
      }));
      const weak = eff.filter((x) => x.e > 1);
      const resist = eff.filter((x) => x.e < 1);
      for (const x of eff) if (x.e >= 4) quad.push(`${x.m.species}:${type}`);
      if (weak.length >= weakMin && resist.length <= resistMax) {
        const score = clamp01(1 - weak.length / ctx.team.length);
        penalty += ctx.param(this.id, "penaltyPerType");
        findings.push({
          explainKey: "defense.sharedWeakness",
          score,
          params: {
            type,
            weak: ids(weak.map((x) => x.m.species)),
            weakCount: weak.length,
            resistCount: resist.length,
          },
          evidence: [
            {
              kind: "calc",
              label: `${type} 技の相性（メガシンカ後・特性による無効を含む）`,
              values: Object.fromEntries(eff.map((x) => [x.m.species, x.e])),
            },
          ],
        });
      }
    }
    penalty += quad.length * ctx.param(this.id, "quadPenalty");
    if (quad.length) {
      findings.push({
        explainKey: "defense.quadWeakness",
        score: clamp01(1 - quad.length * 0.2),
        severity: "info",
        params: { list: quad.join(",") },
        evidence: [{ kind: "calc", label: "4倍弱点", values: { list: quad.join(",") } }],
      });
    }
    return { score: clamp01(1 - penalty), findings };
  },
};

/** Legal species that no damaging move on the team hits super-effectively. */
export const coverageRule: Rule = {
  id: "offense.coverage",
  version: 1,
  category: "offense",
  params: ["maxUnansweredRatio", "listLimit"],
  appliesTo: (ctx) => ctx.team.some((m) => ctx.attackingMoves(m).length > 0),
  evaluate(ctx) {
    const moveTypes = [
      ...new Set(ctx.team.flatMap((m) => ctx.attackingMoves(m).map((a) => a.type))),
    ].sort();
    // Opposing abilities are unknown without usage data; types only (heuristic note in evidence).
    const pool = ctx.threats.length ? ctx.threats.map((t) => t.species) : ctx.pack.legal.species;
    const unanswered = pool.filter((sp) => !moveTypes.some((t) => ctx.effectiveness(t, sp) > 1));
    const ratio = unanswered.length / pool.length;
    const score = clamp01(1 - ratio / ctx.param(this.id, "maxUnansweredRatio"));
    if (score >= 1) return { score, findings: [] };
    const limit = ctx.param(this.id, "listLimit");
    const evidence: Evidence[] = [
      {
        kind: "calc",
        label: "抜群を取れない相手（タイプ相性のみ・相手の特性は考慮しない）",
        values: {
          pool: ctx.threats.length ? "usage" : "legal",
          poolSize: pool.length,
          unanswered: unanswered.length,
          attackTypes: moveTypes.join(","),
        },
      },
    ];
    return {
      score,
      findings: [
        {
          explainKey: ctx.threats.length ? "offense.coverage.threats" : "offense.coverage.legal",
          score,
          params: {
            count: unanswered.length,
            total: pool.length,
            examples: ids(unanswered.slice(0, limit)),
          },
          evidence: evidence as [Evidence, ...Evidence[]],
        },
      ],
    };
  },
};
