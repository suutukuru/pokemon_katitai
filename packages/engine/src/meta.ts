import type { Evidence, TeamRecord } from "@ca/schema";
import { archetypeRules } from "@ca/data";

export interface MetaStats {
  teams: number;
  seasons: string[];
  species: { id: string; count: number; share: number; items: { id: string; count: number }[] }[];
  pairs: { a: string; b: string; count: number; share: number }[];
  archetypes: { id: string; count: number; share: number }[];
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const byCount =
  <T extends { count: number }>(key: (x: T) => string) =>
  (a: T, b: T) =>
    b.count - a.count || key(a).localeCompare(key(b));

/** Frequencies over a set of recorded teams (deterministic ordering). */
export function metaStats(teams: readonly TeamRecord[]): MetaStats {
  const species = new Map<string, { count: number; items: Map<string, number> }>();
  const pairs = new Map<string, number>();
  const arch = new Map<string, number>();
  for (const t of teams) {
    const ids = [...new Set(t.members.map((m) => m.species))].sort();
    for (const m of t.members) {
      const s = species.get(m.species) ?? { count: 0, items: new Map() };
      s.count++;
      const item = m.item ?? "(none)";
      s.items.set(item, (s.items.get(item) ?? 0) + 1);
      species.set(m.species, s);
    }
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const k = `${ids[i]}|${ids[j]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    for (const a of classifyArchetypes(t.members)) arch.set(a.id, (arch.get(a.id) ?? 0) + 1);
  }
  const n = Math.max(1, teams.length);
  return {
    teams: teams.length,
    seasons: [...new Set(teams.map((t) => t.season))].sort(),
    species: [...species]
      .map(([id, s]) => ({
        id,
        count: s.count,
        share: round(s.count / n),
        items: [...s.items].map(([i, c]) => ({ id: i, count: c })).sort(byCount((x) => x.id)),
      }))
      .sort(byCount((x) => x.id)),
    pairs: [...pairs]
      .map(([k, count]) => {
        const [a, b] = k.split("|") as [string, string];
        return { a, b, count, share: round(count / n) };
      })
      .sort(byCount((x) => `${x.a}|${x.b}`)),
    archetypes: [...arch]
      .map(([id, count]) => ({ id, count, share: round(count / n) }))
      .sort(byCount((x) => x.id)),
  };
}

export interface ArchetypeMatch {
  id: string;
  name: string;
  basis: "computed" | "estimated";
  evidence: Evidence;
}

/**
 * Classify a team into archetypes using data rules (packages/data/engine/archetypes.json).
 * A team may match several. `computed` only if an item-determined condition matched.
 */
export function classifyArchetypes(
  members: readonly { species: string; item?: string | undefined }[],
): ArchetypeMatch[] {
  const out: ArchetypeMatch[] = [];
  for (const a of archetypeRules().archetypes) {
    const hits = a.conditions.filter((c) =>
      members.some(
        (m) =>
          (c.species === undefined || c.species === m.species) &&
          (c.item === undefined || c.item === m.item),
      ),
    );
    if (hits.length < a.minMatches) continue;
    const basis = hits.some((h) => h.basis === "computed") ? "computed" : "estimated";
    const values = Object.fromEntries(
      hits.map((h, i) => [`${i + 1}`, `${h.species ?? ""}${h.item ? `@${h.item}` : ""}`]),
    );
    out.push({
      id: a.id,
      name: a.name.ja,
      basis,
      evidence:
        basis === "computed"
          ? { kind: "calc", label: `${a.name.ja}の判定（持ち物から確定）`, values }
          : {
              kind: "heuristic",
              label: `${a.name.ja}の判定`,
              values,
              rationale: hits.map((h) => h.why).join(" / "),
            },
    });
  }
  return out;
}
