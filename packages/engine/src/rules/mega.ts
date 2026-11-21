import type { Rule } from "../rule.js";
import { ids } from "../rule.js";

/** Mega slot usage: only `rules.megaPerBattle` can Mega Evolve per battle. */
export const megaSlotsRule: Rule = {
  id: "mega.slots",
  version: 1,
  category: "mega",
  params: ["maxHolders", "overScore"],
  appliesTo: (ctx) => ctx.pack.mechanics.includes("mega"),
  evaluate(ctx) {
    const holders = ctx.team.filter((m) => ctx.canMega(m));
    const max = ctx.param(this.id, "maxHolders");
    const values = {
      holders: ids(holders.map((m) => m.species)),
      count: holders.length,
      perBattle: ctx.pack.rules.megaPerBattle,
    };
    if (holders.length === 0) {
      return {
        score: 1,
        findings: [
          {
            explainKey: "mega.none",
            score: 1,
            severity: "info",
            params: { perBattle: ctx.pack.rules.megaPerBattle },
            evidence: [{ kind: "calc", label: "メガストーンを持つポケモン", values }],
          },
        ],
      };
    }
    if (holders.length <= max) return { score: 1, findings: [] };
    const score = ctx.param(this.id, "overScore");
    return {
      score,
      findings: [
        {
          explainKey: "mega.tooMany",
          score,
          params: {
            count: holders.length,
            perBattle: ctx.pack.rules.megaPerBattle,
            holders: ids(holders.map((m) => m.species)),
          },
          evidence: [
            {
              kind: "data",
              label: "1試合でメガシンカできる数",
              values,
              source: { title: `レギュレーション ${ctx.pack.id} rules.megaPerBattle` },
            },
          ],
        },
      ],
    };
  },
};
