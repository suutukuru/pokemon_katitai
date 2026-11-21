import { z } from "zod";
import type { TeamDatabaseFile, TeamRecord } from "@ca/schema";
import { resolveName } from "./names.js";

/**
 * Importer for バトルデータベース チャンピオンズ (champs.pokedb.tokyo) open data:
 * https://champs.pokedb.tokyo/opendata/s{season}_{single|double}_ranked_teams.json
 * Terms (2026-11-21): programmatic download allowed without excessive load; apps must
 * download once to their own storage. Only this published open data is used (no scraping).
 */
export const PokedbOpenDataSchema = z.object({
  season: z.string(),
  season_number: z.number().int(),
  rule: z.enum(["シングル", "ダブル"]),
  updated_at: z.string(),
  teams: z.array(
    z.object({
      rank: z.number().int(),
      rating_value: z.number().nullable(),
      team: z
        .array(
          z.object({ id: z.string(), pokemon: z.string(), form: z.string(), item: z.string() }),
        )
        .min(1)
        .max(6),
    }),
  ),
});
export type PokedbOpenData = z.infer<typeof PokedbOpenDataSchema>;

export interface PokedbImportResult {
  file: TeamDatabaseFile;
  issues: string[];
  /**
   * Japanese names of Mega Stones learned from this data: the stone is identified by its holder
   * (e.g. "フラエッテナイト" on Floette → floettite). Fills names missing from PokeAPI.
   */
  learnedItemNames: Record<string, string>;
}

/** Mega Stone IDs usable by a species (from the dex). */
export type MegaStonesFor = (species: string) => string[];

/** "0479-02" (pokedb) → "0479-002" (official site code). */
export const pokedbToOfficialCode = (id: string) => {
  const [dex, form] = id.split("-");
  return `${dex}-${(form ?? "0").padStart(3, "0")}`;
};

/**
 * @param codeToSpecies official code → species ID (from the official eligible-Pokémon list)
 */
export function importPokedb(
  json: unknown,
  codeToSpecies: ReadonlyMap<string, string>,
  url: string,
  megaStonesFor: MegaStonesFor = () => [],
): PokedbImportResult {
  const d = PokedbOpenDataSchema.parse(json);
  const issues: string[] = [];
  const learnedItemNames: Record<string, string> = {};
  const format = d.rule === "ダブル" ? "doubles" : "singles";
  const teams: TeamRecord[] = d.teams.map((t) => {
    const members = t.team.flatMap((p) => {
      const species = codeToSpecies.get(pokedbToOfficialCode(p.id));
      if (!species) {
        issues.push(
          `rank ${t.rank}: unknown pokemon ${p.id} ${p.pokemon}${p.form ? `(${p.form})` : ""}`,
        );
        return [];
      }
      let item: string | undefined;
      if (p.item && p.item !== NO_ITEM) {
        const r = resolveName("items", p.item);
        if (r.kind === "exact" && r.id) item = r.id;
        else {
          const stone = stoneByHolder(p.item, species, megaStonesFor);
          if (stone) {
            item = stone;
            learnedItemNames[stone] = p.item.normalize("NFKC");
          } else
            issues.push(
              `rank ${t.rank}: item "${p.item}" not resolved exactly (${r.candidates[0]?.id ?? "-"})`,
            );
        }
      }
      return [{ species, ...(item ? { item } : {}) }];
    });
    return {
      id: `pokedb-${d.season}-${format}-${t.rank}`,
      season: d.season,
      format,
      rank: t.rank,
      ...(t.rating_value !== null ? { rating: t.rating_value } : {}),
      members,
      published: { items: true, moves: false, sp: false, abilities: false },
      leads: [],
      source: {
        title: `バトルデータベース チャンピオンズ 上位構築データ ${d.season} ${d.rule}`,
        url,
        accessed: d.updated_at.slice(0, 10),
      },
    };
  });
  return {
    file: {
      dataset: "pokedb-opendata",
      season: d.season,
      format,
      updatedAt: d.updated_at,
      source: {
        title: "バトルデータベース チャンピオンズ 上位構築データ",
        url: "https://champs.pokedb.tokyo/guide/opendata",
      },
      license:
        "公開データ（順位・レート・ポケモン・持ち物）。プログラムでの取得は過度な負荷をかけない範囲で可、アプリでは一度自前で保存して利用（同サイトの案内, 2026-11-21確認）。利用規約 第3条（競合サービス関係者のデータ取得の禁止）は商用化前に要確認: docs/OPEN_QUESTIONS.md L-07",
      teams,
    },
    issues,
    learnedItemNames,
  };
}

const NO_ITEM = "持ち物なし";

/** A "〜ナイト" name on a holder with exactly one matching Mega Stone (X/Y/Z by suffix). */
function stoneByHolder(
  name: string,
  species: string,
  megaStonesFor: MegaStonesFor,
): string | undefined {
  const n = name.normalize("NFKC");
  if (!/ナイト[XYZ]?$/.test(n)) return undefined;
  const stones = megaStonesFor(species);
  const suffix = /([XYZ])$/.exec(n)?.[1]?.toLowerCase();
  const pick = suffix
    ? stones.filter((s) => s.endsWith(suffix))
    : stones.filter((s) => !/[xyz]$/.test(s) || stones.length === 1);
  return pick.length === 1 ? pick[0] : undefined;
}
