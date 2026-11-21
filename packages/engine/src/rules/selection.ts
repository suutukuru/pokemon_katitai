import type { PokemonSet } from "@ca/schema";
import type { RuleContext } from "../context.js";
import type { Rule } from "../rule.js";
import { clamp01, ids } from "../rule.js";

export function combinations<T>(xs: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  const [head, ...rest] = xs as [T, ...T[]];
  return [...combinations(rest, k - 1).map((c) => [head, ...c]), ...combinations(rest, k)];
}

/** A bring is "functional" if it has speed control, enough Protect, and no more Mega holders than usable. */
function functional(
  ctx: RuleContext,
  bring: PokemonSet[],
  minProtect: number,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const sc = ctx.tags.moves.speedControl;
  if (!bring.some((m) => m.moves.some((x) => sc[x]))) reasons.push("speedControl");
  if (
    bring.filter((m) => m.moves.some((x) => ctx.tags.moves.protect.includes(x))).length < minProtect
  )
    reasons.push("protect");
  if (bring.filter((m) => ctx.canMega(m)).length > ctx.pack.rules.megaPerBattle + 1)
    reasons.push("megaOverload");
  return { ok: reasons.length === 0, reasons };
}

/** How many of the C(6,4) brings are functional. */
export const selectionRule: Rule = {
  id: "selection.flexibility",
  version: 1,
  category: "selection",
  params: ["minRatio", "minProtect"],
  appliesTo: (ctx) => ctx.team.length > ctx.pack.rules.bringCount,
  evaluate(ctx) {
    const minProtect = ctx.param(this.id, "minProtect");
    const brings = combinations(ctx.team, ctx.pack.rules.bringCount);
    const results = brings.map((b) => ({ b, ...functional(ctx, b, minProtect) }));
    const good = results.filter((r) => r.ok);
    const ratio = good.length / results.length;
    const score = clamp01(ratio / ctx.param(this.id, "minRatio"));
    // members that appear in every functional bring are load-bearing
    const essential = ctx.team
      .filter((m) => good.length > 0 && good.every((g) => g.b.includes(m)))
      .map((m) => m.species);
    if (score >= 1 && essential.length === 0) return { score, findings: [] };
    const reasonCounts: Record<string, number> = {};
    for (const r of results)
      for (const x of r.reasons) reasonCounts[x] = (reasonCounts[x] ?? 0) + 1;
    return {
      score,
      findings: [
        {
          explainKey:
            essential.length && score >= 1 ? "selection.essential" : "selection.inflexible",
          score: Math.min(score, essential.length ? 0.75 : 1),
          params: { good: good.length, total: results.length, essential: ids(essential) },
          evidence: [
            {
              kind: "calc",
              label: `選出${ctx.pack.rules.bringCount}体の全${results.length}通りのうち成立する数（すばやさ操作あり・まもる${minProtect}体以上）`,
              values: {
                good: good.length,
                total: results.length,
                ...Object.fromEntries(
                  Object.entries(reasonCounts).map(([k, v]) => [`missing_${k}`, v]),
                ),
              },
            },
          ],
        },
      ],
    };
  },
};
