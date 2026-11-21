import { PokemonSetSchema, type PokemonSet, type TeamRecord, type UsageSnapshot } from "@ca/schema";
import type { Dex } from "./dex.js";
import { mostCommonSet } from "./smogon.js";

export interface EstimatedTeam {
  sets: PokemonSet[];
  /** Species with no usage data (could not be completed). */
  missing: string[];
  source: string;
}

/**
 * Complete a recorded team (species + items from open data) with the most common
 * moves/ability/nature/SP from a usage snapshot. Every filled field is listed in `assumed`.
 */
export function estimateTeam(record: TeamRecord, usage: UsageSnapshot, dex: Dex): EstimatedTeam {
  const sets: PokemonSet[] = [];
  const missing: string[] = [];
  for (const m of record.members) {
    const isStone = (item?: string) =>
      !!item &&
      (dex
        .megaStones()
        .get(item)
        ?.some((e) => e.baseId === m.species) ??
        false);
    const wantMega = isStone(m.item);
    const candidates = usage.entries.filter((e) => e.species === m.species && e.distributions);
    const entry = candidates.find((e) => (e.sets[0]?.mega ?? false) === wantMega) ?? candidates[0];
    const d = entry?.distributions;
    const common = d ? mostCommonSet(d, m.item) : undefined;
    if (!entry || !common) {
      missing.push(m.species);
      continue;
    }
    const ability = entry.sets[0]?.ability ?? common.ability;
    const assumed = ["moves", "ability", "nature", "sp", ...(m.item ? [] : ["item"])];
    const moveShare = Object.fromEntries((d?.moves ?? []).map((x) => [x.id, x.share]));
    const confidence: Record<string, number> = {
      nature: d?.spreads[0]?.share ?? 0,
      sp: d?.spreads[0]?.share ?? 0,
    };
    common.moves.forEach((mv, i) => (confidence[`moves.${i}`] = moveShare[mv] ?? 0));
    sets.push(
      PokemonSetSchema.parse({
        species: m.species,
        ...((m.item ?? common.item) ? { item: m.item ?? common.item } : {}),
        ability,
        nature: common.nature,
        sp: common.sp,
        moves: common.moves,
        confidence,
        assumed,
      }),
    );
  }
  return { sets, missing, source: usage.source.title };
}
