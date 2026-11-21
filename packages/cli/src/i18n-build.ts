import { toID, type I18nNames, type MoveMeta, type NameKind } from "@ca/schema";
import type { Dex } from "@ca/data";
import type { ImportedSpecies } from "@ca/data";

/** Minimal RFC4180 CSV parser (quoted fields, escaped quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** PokeAPI identifiers whose Showdown ID is spelled differently. */
const ALIASES: Record<string, string> = { vicegrip: "visegrip" };
const sdId = (identifier: string) => {
  const id = toID(identifier);
  return ALIASES[id] ?? id;
};

/** PokeAPI language IDs: 1 = ja-Hrkt (kana, as shown in-game), 9 = en. */
const JA = "1";
const EN = "9";

interface CsvPair {
  /** e.g. moves.csv: id → identifier */
  entities: string;
  /** e.g. move_names.csv */
  names: string;
  idColumn: string;
}

function namesFromPokeApi(pair: CsvPair, keep: (id: string) => boolean): I18nNames["moves"] {
  const identifiers = new Map(parseCsv(pair.entities).map((r) => [r["id"]!, r["identifier"]!]));
  const out: Record<string, { ja?: string; en: string }> = {};
  const ja = new Map<string, string>();
  const en = new Map<string, string>();
  for (const r of parseCsv(pair.names)) {
    const ident = identifiers.get(r[pair.idColumn]!);
    if (!ident) continue;
    const id = sdId(ident);
    // NFKC: PokeAPI has full-width digits/letters (１０まんばりき, リザードナイトＹ); the game shows half-width.
    if (r["local_language_id"] === JA) ja.set(id, r["name"]!.normalize("NFKC"));
    if (r["local_language_id"] === EN) en.set(id, r["name"]!);
  }
  for (const [id, name] of [...en].sort(([a], [b]) => a.localeCompare(b))) {
    if (!keep(id)) continue;
    const j = ja.get(id);
    out[id] = j !== undefined ? { ja: j, en: name } : { en: name };
  }
  return out;
}

export interface PokeApiCsvs {
  pokemon_species: string;
  pokemon_species_names: string;
  moves: string;
  move_names: string;
  abilities: string;
  ability_names: string;
  items: string;
  item_names: string;
  natures: string;
  nature_names: string;
  types: string;
  type_names: string;
}

/**
 * Build the ja/en name table. Species names prefer the official Champions site
 * (which also names regional formes); other kinds come from PokeAPI CSVs.
 * Only IDs present in the dex are kept.
 */
export function buildNames(
  csv: PokeApiCsvs,
  official: readonly ImportedSpecies[],
  dex: Dex,
  meta: Pick<I18nNames, "version" | "sources">,
): { names: I18nNames; missingJa: Record<NameKind, string[]> } {
  const has = (kind: "species" | "moves" | "items" | "abilities") => {
    const set = new Set(dex.ids(kind));
    return (id: string) => set.has(id);
  };
  const species = namesFromPokeApi(
    {
      entities: csv.pokemon_species,
      names: csv.pokemon_species_names,
      idColumn: "pokemon_species_id",
    },
    has("species"),
  );
  for (const s of official) {
    species[s.id] = s.ja !== undefined ? { ja: s.ja, en: s.en } : { en: s.en };
  }
  const names: I18nNames = {
    ...meta,
    species: sortRecord(species),
    moves: namesFromPokeApi(
      { entities: csv.moves, names: csv.move_names, idColumn: "move_id" },
      has("moves"),
    ),
    abilities: namesFromPokeApi(
      { entities: csv.abilities, names: csv.ability_names, idColumn: "ability_id" },
      has("abilities"),
    ),
    items: namesFromPokeApi(
      { entities: csv.items, names: csv.item_names, idColumn: "item_id" },
      has("items"),
    ),
    natures: namesFromPokeApi(
      { entities: csv.natures, names: csv.nature_names, idColumn: "nature_id" },
      () => true,
    ),
    types: namesFromPokeApi(
      { entities: csv.types, names: csv.type_names, idColumn: "type_id" },
      (id) => !["unknown", "shadow"].includes(id),
    ),
  };
  const missingJa = Object.fromEntries(
    (["species", "moves", "abilities", "items", "natures", "types"] as const).map((k) => [
      k,
      Object.entries(names[k])
        .filter(([, v]) => v.ja === undefined)
        .map(([id]) => id),
    ]),
  ) as Record<NameKind, string[]>;
  return { names, missingJa };
}

function sortRecord<V>(r: Record<string, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
}

/** Accuracy / priority / target / secondary chance per move, keyed by Showdown ID. */
export function buildMoveMeta(
  movesCsv: string,
  targetsCsv: string,
  dex: Dex,
  meta: Pick<MoveMeta, "version" | "sources">,
): MoveMeta {
  const targets = new Map(parseCsv(targetsCsv).map((r) => [r["id"]!, r["identifier"]!]));
  const keep = new Set(dex.ids("moves"));
  const num = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
  const moves: MoveMeta["moves"] = {};
  for (const r of parseCsv(movesCsv).sort((a, b) =>
    sdId(a["identifier"]!).localeCompare(sdId(b["identifier"]!)),
  )) {
    const id = sdId(r["identifier"]!);
    if (!keep.has(id)) continue;
    moves[id] = {
      // PokeAPI uses 0 for "cannot miss" on some newer moves (e.g. Tachyon Cutter)
      accuracy: num(r["accuracy"]) || null,
      pp: num(r["pp"]),
      priority: Number(r["priority"] ?? 0),
      target: targets.get(r["target_id"]!) ?? "unknown",
      effectChance: num(r["effect_chance"]),
    };
  }
  return { ...meta, moves };
}
