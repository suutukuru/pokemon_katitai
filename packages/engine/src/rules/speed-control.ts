import type { Rule } from "../rule.js";
import { ids } from "../rule.js";

/** Speed control (Tailwind / Trick Room / speed drops / paralysis) presence and strength. */
export const speedControlRule: Rule = {
  id: "speedControl.presence",
  version: 1,
  category: "speedControl",
  params: ["scoreNone", "scoreWeakOnly"],
  appliesTo: () => true,
  evaluate(ctx) {
    const sc = ctx.tags.moves.speedControl;
    const users = ctx.membersWithMove(sc);
    const kinds = new Set(users.flatMap((u) => u.moves.map((m) => sc[m]!)));
    const strong = kinds.has("tailwind") || kinds.has("trickroom");
    const score = strong
      ? 1
      : users.length
        ? ctx.param(this.id, "scoreWeakOnly")
        : ctx.param(this.id, "scoreNone");
    const evidence = [
      {
        kind: "calc" as const,
        label: "すばやさ操作の技",
        values: {
          users: ids(users.map((u) => u.member.species)),
          moves: ids([...new Set(users.flatMap((u) => u.moves))]),
          tailwind: kinds.has("tailwind"),
          trickroom: kinds.has("trickroom"),
          speedDrop: kinds.has("speedDrop"),
          paralysis: kinds.has("paralysis"),
        },
      },
    ] as const;
    if (strong) return { score, findings: [] };
    return {
      score,
      findings: [
        {
          explainKey: users.length ? "speedControl.weakOnly" : "speedControl.none",
          score,
          params: { moves: ids([...new Set(users.flatMap((u) => u.moves))]) },
          evidence: [...evidence],
        },
      ],
    };
  },
};
