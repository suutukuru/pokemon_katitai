import type { Rule } from "../rule.js";
import { ids } from "../rule.js";

/** Conflicting weather/terrain setters on the same team (e.g. Drought vs Sand Stream). */
export const fieldConflictRule: Rule = {
  id: "field.conflict",
  version: 1,
  category: "field",
  params: ["conflictScore"],
  appliesTo: () => true,
  evaluate(ctx) {
    const findings = [];
    for (const kind of ["weather", "terrain"] as const) {
      const byAbility = ctx.tags.abilities[kind] as Record<string, string>;
      const byMove = ctx.tags.moves[kind] as Record<string, string>;
      const setters = new Map<string, string[]>();
      for (const m of ctx.team) {
        const a = ctx.abilities(m).filter((x) => byAbility[x]);
        const mv = m.moves.filter((x) => byMove[x]);
        for (const src of [
          ...a.map((x) => [byAbility[x]!, `${m.species}:${x}`]),
          ...mv.map((x) => [byMove[x]!, `${m.species}:${x}`]),
        ]) {
          setters.set(src[0]!, [...(setters.get(src[0]!) ?? []), src[1]!]);
        }
      }
      if (setters.size >= 2) {
        const score = ctx.param(this.id, "conflictScore");
        const entries = [...setters].sort(([a], [b]) => a.localeCompare(b));
        findings.push({
          explainKey: `field.conflict.${kind}`,
          score,
          params: {
            kinds: entries.map(([k]) => k).join(","),
            setters: ids(entries.flatMap(([, v]) => v)),
          },
          evidence: [
            {
              kind: "calc" as const,
              label: kind === "weather" ? "天気を変える特性・技" : "フィールドを変える特性・技",
              values: Object.fromEntries(entries.map(([k, v]) => [k, v.join(",")])),
            },
          ] as [{ kind: "calc"; label: string; values: Record<string, string> }],
        });
      }
    }
    return { score: findings.length ? Math.min(...findings.map((f) => f.score)) : 1, findings };
  },
};
