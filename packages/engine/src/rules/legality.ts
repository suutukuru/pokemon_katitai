import { STAT_IDS } from "@ca/schema";
import { validateSp } from "@ca/calc";
import type { FindingDraft, Rule } from "../rule.js";

/** Team legality under the regulation: species/items/moves, clauses, SP caps. Always critical. */
export const legalityRule: Rule = {
  id: "legality.team",
  version: 1,
  category: "legality",
  params: [],
  appliesTo: () => true,
  evaluate(ctx) {
    const { pack } = ctx;
    const findings: FindingDraft[] = [];
    const add = (explainKey: string, params: FindingDraft["params"], label: string) =>
      findings.push({
        explainKey,
        score: 0,
        severity: "critical",
        params,
        evidence: [
          {
            kind: "data",
            label,
            values: { ...params, regulation: pack.id },
            source: { title: `レギュレーション ${pack.id}（${pack.dataVersion}）` },
          },
        ],
      });
    if (ctx.team.length > pack.rules.teamSize)
      add(
        "legality.teamSize",
        { count: ctx.team.length, max: pack.rules.teamSize },
        "チームの人数",
      );
    ctx.team.forEach((m, i) => {
      if (!pack.legal.species.includes(m.species))
        add("legality.species", { member: m.species, slot: i + 1 }, "使用可能ポケモン");
      if (m.item && !pack.legal.items.includes(m.item))
        add("legality.item", { member: m.species, item: m.item }, "使用可能な持ち物");
      for (const mv of m.moves)
        if (pack.legal.bannedMoves.includes(mv))
          add("legality.move", { member: m.species, move: mv }, "禁止技");
      if (pack.legal.bannedAbilities.includes(m.ability))
        add("legality.ability", { member: m.species, ability: m.ability }, "禁止特性");
      for (const issue of validateSp(ctx.spec, m.sp)) {
        const total = STAT_IDS.reduce((a, s) => a + m.sp[s], 0);
        add(
          "legality.sp",
          {
            member: m.species,
            detail: issue.message,
            total,
            cap: ctx.spec.statPoints.total.value,
            perStat: ctx.spec.statPoints.perStat.value,
          },
          "SP の上限",
        );
      }
    });
    const dup = (xs: (string | undefined)[]) =>
      [...new Set(xs.filter((x, i) => x !== undefined && xs.indexOf(x) !== i))] as string[];
    if (pack.rules.speciesClause)
      for (const s of dup(ctx.team.map((m) => ctx.dex.species(m.species)?.baseId ?? m.species)))
        add("legality.speciesClause", { member: s }, "同じポケモンは1匹まで");
    if (pack.rules.itemClause)
      for (const it of dup(ctx.team.map((m) => m.item)))
        add("legality.itemClause", { item: it }, "同じ持ち物は1つまで");
    return { score: findings.length ? 0 : 1, findings };
  },
};
