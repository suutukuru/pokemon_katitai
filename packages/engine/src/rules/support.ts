import type { Rule } from "../rule.js";
import { ids } from "../rule.js";
import type { RuleContext } from "../context.js";

type Pick = (
  ctx: RuleContext,
) => { member: { species: string }; moves?: string[]; abilities?: string[] }[];

function presenceRule(id: string, explainKey: string, label: string, pick: Pick): Rule {
  return {
    id,
    version: 1,
    category: "support",
    params: ["missingScore"],
    appliesTo: () => true,
    evaluate(ctx) {
      const users = pick(ctx);
      if (users.length > 0) return { score: 1, findings: [] };
      const score = ctx.param(id, "missingScore");
      return {
        score,
        findings: [
          {
            explainKey,
            score,
            params: { count: 0 },
            evidence: [
              {
                kind: "calc",
                label,
                values: { count: 0, checked: ids(ctx.team.map((m) => m.species)) },
              },
            ],
          },
        ],
      };
    },
  };
}

export const fakeOutRule = presenceRule(
  "support.fakeout",
  "support.fakeout.missing",
  "ねこだまし持ちの数",
  (ctx) => ctx.membersWithMove(ctx.tags.moves.fakeOut),
);
export const intimidateRule = presenceRule(
  "support.intimidate",
  "support.intimidate.missing",
  "いかく持ちの数",
  (ctx) => ctx.membersWithAbility(ctx.tags.abilities.intimidate),
);
export const redirectionRule = presenceRule(
  "support.redirection",
  "support.redirection.missing",
  "このゆびとまれ・いかりのこな持ちの数",
  (ctx) => ctx.membersWithMove(ctx.tags.moves.redirection),
);

/** Protect density: doubles teams want most members to carry Protect. */
export const protectRule: Rule = {
  id: "support.protect",
  version: 1,
  category: "support",
  params: ["min", "target"],
  appliesTo: () => true,
  evaluate(ctx) {
    const users = ctx.membersWithMove(ctx.tags.moves.protect);
    const min = ctx.param(this.id, "min");
    const score = Math.min(1, users.length / ctx.param(this.id, "target"));
    if (users.length >= min) return { score, findings: [] };
    const without = ctx.team
      .filter((m) => !users.some((u) => u.member === m))
      .map((m) => m.species);
    return {
      score,
      findings: [
        {
          explainKey: "support.protect.few",
          score,
          params: { count: users.length, min, without: ids(without) },
          evidence: [
            {
              kind: "calc",
              label: "まもる系の技を持つ数",
              values: { count: users.length, min, users: ids(users.map((u) => u.member.species)) },
            },
          ],
        },
      ],
    };
  },
};
