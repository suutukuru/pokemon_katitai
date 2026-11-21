import { Generations } from "@smogon/calc";
import { z } from "zod";
import { STAT_IDS, toID, type StatsTable, type UsageSnapshot } from "@ca/schema";
import type { Dex } from "./dex.js";

/**
 * Importer for Smogon's monthly Pokémon Showdown usage statistics ("chaos" JSON), e.g.
 * https://www.smogon.com/stats/2026-10/chaos/gen9championsvgc2026regmc-1760.json
 * These are Showdown ladder games (not in-game ranked); entries are marked accordingly.
 */
const Counts = z.record(z.string(), z.number());
export const SmogonChaosSchema = z.object({
  info: z.object({ metagame: z.string(), cutoff: z.number(), "number of battles": z.number() }),
  data: z.record(
    z.string(),
    z.object({
      usage: z.number(),
      Abilities: Counts,
      Items: Counts,
      Moves: Counts,
      Spreads: Counts,
      Teammates: Counts,
    }),
  ),
});

export interface SmogonImportOptions {
  regulationId: string;
  /** "YYYY-MM" of the stats month; the snapshot date is the month's last day. */
  month: string;
  url: string;
  legalSpecies: readonly string[];
  dex: Dex;
  /** Keep species with usage ≥ this (0..1). */
  minUsage: number;
  /** Keep this many entries in each distribution. */
  topK: number;
}

const gen = Generations.get(9);
const NATURES = new Set<string>([...gen.natures].map((n) => n.name));
const CHOICE = new Set(["choicescarf", "choiceband", "choicespecs"]);

function shares(
  c: Record<string, number>,
  total: number,
  topK: number,
  map: (k: string) => string = toID,
) {
  return Object.entries(c)
    .filter(([k, v]) => v > 0 && k !== "" && k !== "nothing")
    .map(([k, v]) => ({ id: map(k), share: Math.round(Math.min(1, v / total) * 1000) / 1000 }))
    .sort((a, b) => b.share - a.share || a.id.localeCompare(b.id))
    .slice(0, topK);
}

function parseSpread(key: string): { nature: string; sp: StatsTable } | undefined {
  const [nature, nums] = key.split(":");
  const xs = (nums ?? "").split("/").map(Number);
  if (!nature || !NATURES.has(nature) || xs.length !== 6 || xs.some((x) => !Number.isInteger(x)))
    return undefined;
  return { nature, sp: Object.fromEntries(STAT_IDS.map((s, i) => [s, xs[i]!])) as StatsTable };
}

/**
 * Most common set from marginal distributions: top item, ability, spread, and the top 4 moves
 * compatible with the item (no status moves with a Choice item). It is an estimate.
 */
export function mostCommonSet(
  d: NonNullable<UsageSnapshot["entries"][number]["distributions"]>,
  item: string | undefined,
): { moves: string[]; ability: string; nature: string; sp: StatsTable; item?: string } | undefined {
  const it = item ?? d.items[0]?.id;
  const spread = d.spreads[0];
  const ability = d.abilities[0]?.id;
  if (!spread || !ability) return undefined;
  const ok = (m: string) =>
    !(it && CHOICE.has(it) && gen.moves.get(m as never)?.category === "Status");
  const moves = d.moves
    .map((m) => m.id)
    .filter((m) => gen.moves.get(m as never) && ok(m))
    .slice(0, 4);
  if (moves.length === 0) return undefined;
  return { moves, ability, nature: spread.nature, sp: spread.sp, ...(it ? { item: it } : {}) };
}

export function importSmogonChaos(
  json: unknown,
  o: SmogonImportOptions,
): { snapshot: UsageSnapshot; skipped: string[] } {
  const c = SmogonChaosSchema.parse(json);
  const legal = new Set(o.legalSpecies);
  const skipped: string[] = [];
  const entries: UsageSnapshot["entries"] = [];
  for (const [name, v] of Object.entries(c.data)) {
    if (v.usage < o.minUsage) continue;
    const id = toID(name);
    const sp = o.dex.species(id);
    // Mega base from the stone mapping (Floette-Mega evolves from Floette-Eternal, not Floette)
    const fromStone = [...o.dex.megaStones().values()].flat().find((e) => e.megaId === id)?.baseId;
    const base = sp?.isMega ? (fromStone ?? sp.baseId) : id;
    if (!sp || !legal.has(base)) {
      skipped.push(name);
      continue;
    }
    const total = Object.values(v.Abilities).reduce((a, x) => a + x, 0) || 1;
    const spreads = Object.entries(v.Spreads)
      .map(([k, n]) => ({ s: parseSpread(k), n }))
      .filter((x): x is { s: { nature: string; sp: StatsTable }; n: number } => !!x.s)
      .sort((a, b) => b.n - a.n)
      .slice(0, o.topK)
      .map((x) => ({
        nature: x.s.nature,
        sp: x.s.sp,
        share: Math.round((x.n / total) * 1000) / 1000,
      }));
    const distributions = {
      moves: shares(v.Moves, total, o.topK),
      items: shares(v.Items, total, o.topK),
      abilities: shares(v.Abilities, total, o.topK),
      spreads,
      teammates: shares(v.Teammates, Math.max(...Object.values(v.Teammates), 1), o.topK),
    };
    const common = mostCommonSet(distributions as never, undefined);
    // Stats list the Mega forme's ability (e.g. Drought); the team holds the base ability.
    const baseAbility = gen.species.get(base as never)?.abilities?.[0];
    const set =
      common && sp.isMega && baseAbility ? { ...common, ability: toID(baseAbility) } : common;
    entries.push({
      species: base,
      usage: Math.round(v.usage * 10000) / 10000,
      sets: set ? [{ share: 1, ...set, mega: !!sp.isMega }] : [],
      distributions: distributions as never,
    } as UsageSnapshot["entries"][number]);
  }
  entries.sort((a, b) => b.usage - a.usage || a.species.localeCompare(b.species));
  const [y, m] = o.month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return {
    snapshot: {
      regulationId: o.regulationId,
      date: last,
      format: "doubles",
      source: {
        title: `Smogon usage stats ${o.month} ${c.info.metagame} (Pokémon Showdown ladder, rating ≥ ${c.info.cutoff})`,
        url: o.url,
        accessed: last,
      },
      sample: false,
      battles: c.info["number of battles"],
      cutoff: c.info.cutoff,
      entries,
    },
    skipped,
  };
}
