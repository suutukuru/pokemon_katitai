import { toID } from "@ca/schema";
import type { Dex } from "./dex.js";

/**
 * Importer for the official event pages at web-view.app.pokemonchampions.jp
 * (`.../events/<eventId>/<lang>/pokemon.html`), which embed
 * `const pokemons = [["0006-000", 1, "Charizard"], ...]`.
 */
export type OfficialPokemonEntry = [code: string, flag: number, name: string];

export function parseOfficialPokemonPage(html: string): OfficialPokemonEntry[] {
  const m = /const pokemons = (\[[\s\S]*?\]);/.exec(html);
  if (!m?.[1]) throw new Error("official page: `const pokemons = [...]` not found");
  const data: unknown = JSON.parse(m[1]);
  if (
    !Array.isArray(data) ||
    !data.every(
      (e) =>
        Array.isArray(e) &&
        typeof e[0] === "string" &&
        /^\d{4}-\d{3}$/.test(e[0]) &&
        typeof e[1] === "number" &&
        typeof e[2] === "string",
    )
  ) {
    throw new Error("official page: unexpected `pokemons` format");
  }
  return data as OfficialPokemonEntry[];
}

const REGIONAL: Record<string, string> = {
  "Alolan Form": "Alola",
  "Galarian Form": "Galar",
  "Hisuian Form": "Hisui",
};
/** Official English form labels → Showdown forme suffix ("" = base forme). */
const FORM_SUFFIX: Record<string, string> = {
  "Paldean Form (Combat Breed)": "Paldea-Combat",
  "Paldean Form (Blaze Breed)": "Paldea-Blaze",
  "Paldean Form (Aqua Breed)": "Paldea-Aqua",
  Rotom: "",
  "Heat Rotom": "Heat",
  "Wash Rotom": "Wash",
  "Frost Rotom": "Frost",
  "Fan Rotom": "Fan",
  "Mow Rotom": "Mow",
  Male: "",
  Female: "F",
  "Medium Variety": "",
  "Small Variety": "Small",
  "Large Variety": "Large",
  "Jumbo Variety": "Super",
  "Midday Form": "",
  "Midnight Form": "Midnight",
  "Dusk Form": "Dusk",
  "Amped Form": "",
  "Low Key Form": "Low-Key",
};

/** "Raichu (Alolan Form)" → "raichualola". Returns undefined for unknown form labels. */
export function officialEnglishToId(name: string): string | undefined {
  const m = /^(.*?) \((.*)\)$/.exec(name);
  if (!m) return toID(name);
  const [, base, form] = m as unknown as [string, string, string];
  const suffix = REGIONAL[form] ?? FORM_SUFFIX[form];
  if (suffix === undefined) return undefined;
  return toID(suffix ? `${base}-${suffix}` : base);
}

/** Entries whose official English name does not distinguish the forme. Keyed by official code. */
const CODE_TO_ID: Record<string, string> = {
  // listed as plain "Floette", but form 005 is the Eternal Flower (the Mega-capable forme)
  "0670-005": "floetteeternal",
  "0931-001": "squawkabillyblue",
  "0931-002": "squawkabillyyellow",
  "0931-003": "squawkabillywhite",
};

export interface ImportedSpecies {
  id: string;
  code: string;
  en: string;
  ja: string | undefined;
}

/** Join the en/ja lists by official code and resolve each entry against the dex. */
export function importOfficialSpecies(
  en: readonly OfficialPokemonEntry[],
  ja: readonly OfficialPokemonEntry[],
  dex: Dex,
): { species: ImportedSpecies[]; unresolved: string[] } {
  const jaByCode = new Map(ja.map((e) => [e[0], e[2]]));
  const species: ImportedSpecies[] = [];
  const unresolved: string[] = [];
  for (const [code, , name] of en) {
    const id = CODE_TO_ID[code] ?? officialEnglishToId(name);
    if (id === undefined || !dex.species(id)) unresolved.push(`${code} ${name}`);
    else species.push({ id, code, en: name, ja: jaByCode.get(code) });
  }
  return { species, unresolved };
}
