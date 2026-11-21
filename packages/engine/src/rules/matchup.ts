import type { Rule } from "../rule.js";
import { ids } from "../rule.js";

/** Answers to an opposing Trick Room: own Trick Room, Taunt/Imprison, Fake Out on the setter, slow attackers. */
export const trickRoomAnswerRule: Rule = {
  id: "matchup.trickRoomAnswer",
  version: 1,
  category: "matchup",
  params: ["slowSpeed", "missingScore"],
  appliesTo: () => true,
  evaluate(ctx) {
    const slow = ctx.param(this.id, "slowSpeed");
    const answers = {
      trickroom: ctx.membersWithMove(["trickroom"]).map((u) => u.member.species),
      taunt: ctx.membersWithMove(["taunt", "imprison"]).map((u) => u.member.species),
      fakeout: ctx.membersWithMove(ctx.tags.moves.fakeOut).map((u) => u.member.species),
      slow: ctx.team.filter((m) => ctx.stats(m, ctx.canMega(m)).spe <= slow).map((m) => m.species),
    };
    const any = Object.values(answers).some((a) => a.length > 0);
    if (any) return { score: 1, findings: [] };
    const score = ctx.param(this.id, "missingScore");
    return {
      score,
      findings: [
        {
          explainKey: "matchup.trickRoom.noAnswer",
          score,
          params: { slowSpeed: slow },
          evidence: [
            {
              kind: "calc",
              label: "トリックルームへの対策（技・遅いポケモン）",
              values: {
                trickroom: ids(answers.trickroom),
                taunt: ids(answers.taunt),
                fakeout: ids(answers.fakeout),
                slow: ids(answers.slow),
                slowSpeed: slow,
              },
            },
          ],
        },
      ],
    };
  },
};
