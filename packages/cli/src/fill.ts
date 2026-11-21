import { PokemonSetSchema, type PokemonSet, type UsageSnapshot } from "@ca/schema";
import { mostCommonSet, type Dex } from "@ca/data";

/**
 * Build a candidate member from usage data. `id` may be a Mega forme ID (e.g. "tyranitarmega"):
 * then the base species with its Mega Stone is used. Items already on the team are avoided
 * (item clause) by taking the next most common item.
 */
export function candidateSet(
  id: string,
  usage: UsageSnapshot,
  dex: Dex,
  usedItems: ReadonlySet<string>,
): PokemonSet | undefined {
  const base = dex.species(id)?.isMega
    ? [...dex.megaStones().values()].flat().find((e) => e.megaId === id)?.baseId
    : id;
  if (!base) return undefined;
  const wantMega = base !== id;
  const entries = usage.entries.filter((e) => e.species === base && e.distributions);
  const entry = entries.find((e) => (e.sets[0]?.mega ?? false) === wantMega) ?? entries[0];
  const d = entry?.distributions;
  if (!entry || !d) return undefined;
  const item = wantMega ? entry.sets[0]?.item : d.items.find((i) => !usedItems.has(i.id))?.id;
  if (item && usedItems.has(item)) return undefined;
  const s = mostCommonSet(d, item);
  if (!s) return undefined;
  return PokemonSetSchema.parse({
    species: base,
    ...(item ? { item } : {}),
    ability: entry.sets[0]?.ability ?? s.ability,
    nature: s.nature,
    sp: s.sp,
    moves: s.moves,
    assumed: ["moves", "ability", "nature", "sp", "item"],
  });
}

/** All pairs of candidates that respect species/item clauses with the draft. */
export function candidatePairs(
  draft: PokemonSet[],
  candidates: string[],
  usage: UsageSnapshot,
  dex: Dex,
): { ids: [string, string]; team: PokemonSet[] }[] {
  const out: { ids: [string, string]; team: PokemonSet[] }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const used = new Set(draft.map((m) => m.item).filter((x): x is string => !!x));
      const a = candidateSet(candidates[i]!, usage, dex, used);
      if (!a) continue;
      if (a.item) used.add(a.item);
      const b = candidateSet(candidates[j]!, usage, dex, used);
      if (!b) continue;
      const species = new Set([...draft, a, b].map((m) => m.species));
      if (species.size !== draft.length + 2) continue;
      out.push({ ids: [candidates[i]!, candidates[j]!], team: [...draft, a, b] });
    }
  }
  return out;
}
