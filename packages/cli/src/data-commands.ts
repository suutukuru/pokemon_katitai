// Node-only data maintenance commands (read local files fetched by the user; no scraping).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baseDex,
  dexWithNewSpecies,
  importOfficialSpecies,
  loadAllPacks,
  parseOfficialPokemonPage,
} from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { buildMoveMeta, buildNames, type PokeApiCsvs } from "./i18n-build.js";
import type { Io } from "./commands.js";

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../data");

/** Base dex plus every pack's newSpecies, so species added by packs resolve too. */
function dexWithAllPacks() {
  const newSpecies = Object.assign(
    {},
    ...loadAllPacks(new FsPackSource()).map((r) => r.pack?.overrides.newSpecies ?? {}),
  ) as Parameters<typeof dexWithNewSpecies>[1];
  return dexWithNewSpecies(baseDex(), newSpecies);
}

function readOfficial(dir: string) {
  const page = (lang: string) =>
    parseOfficialPokemonPage(readFileSync(join(dir, `pokemon_${lang}.html`), "utf8"));
  return importOfficialSpecies(page("en"), page("ja"), dexWithAllPacks());
}

/**
 * `data:import-official <dir>` — dir holds pokemon_en.html / pokemon_ja.html saved from
 * https://web-view.app.pokemonchampions.jp/battle/pages/events/<eventId>/<lang>/pokemon.html
 * Prints the species IDs for legal.json and any entries that could not be resolved.
 */
export function importOfficial(args: string[], io: Io): number {
  const dir = args[0];
  if (!dir) {
    io.err("usage: pnpm data:import-official <dir with pokemon_en.html and pokemon_ja.html>");
    return 2;
  }
  const r = readOfficial(dir);
  io.out(JSON.stringify(r.species.map((s) => s.id)));
  for (const u of r.unresolved)
    io.err(`unresolved: ${u} (add to overrides.newSpecies or fix the form mapping)`);
  return 0;
}

/** `data:build-i18n --pokeapi <csv dir> --official <dir> --version <v>` → packages/data/i18n/names.json */
export function buildI18n(args: string[], io: Io): number {
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const pokeapi = get("pokeapi");
  const official = get("official");
  const version = get("version") ?? new Date().toISOString().slice(0, 10);
  if (!pokeapi || !official) {
    io.err(
      "usage: pnpm data:build-i18n --pokeapi <PokeAPI data/v2/csv dir> --official <dir> [--version v]",
    );
    return 2;
  }
  const files = [
    "pokemon_species",
    "pokemon_species_names",
    "moves",
    "move_names",
    "abilities",
    "ability_names",
    "items",
    "item_names",
    "natures",
    "nature_names",
    "types",
    "type_names",
  ] as const;
  const csv = Object.fromEntries(
    files.map((f) => [f, readFileSync(join(pokeapi, `${f}.csv`), "utf8")]),
  ) as unknown as PokeApiCsvs;
  const { names, missingJa } = buildNames(csv, readOfficial(official).species, dexWithAllPacks(), {
    version,
    sources: [
      {
        title: "Pokémon Champions 公式 参加できるポケモン（種族名 ja/en）",
        url: "https://web-view.app.pokemonchampions.jp/battle/pages/events/rs178713870219xeaaio/ja/pokemon.html",
        accessed: version,
      },
      {
        title: "PokeAPI data/v2/csv (BSD-3-Clause)（技・特性・持ち物・性格・タイプ名、ja-Hrkt/en）",
        url: "https://github.com/PokeAPI/pokeapi/tree/master/data/v2/csv",
        accessed: version,
      },
    ],
  });
  const out = join(DATA_DIR, "i18n/names.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(names, null, 1) + "\n");
  io.out(`wrote ${out}`);
  for (const [k, ids] of Object.entries(missingJa))
    if (ids.length) io.out(`  ja missing (${k}): ${ids.length}`);
  const moveMeta = buildMoveMeta(
    csv.moves,
    readFileSync(join(pokeapi, "move_targets.csv"), "utf8"),
    baseDex(),
    { version, sources: [names.sources[1]!] },
  );
  const out2 = join(DATA_DIR, "base/moves.json");
  mkdirSync(dirname(out2), { recursive: true });
  writeFileSync(out2, JSON.stringify(moveMeta, null, 1) + "\n");
  io.out(`wrote ${out2} (${Object.keys(moveMeta.moves).length} moves)`);
  return 0;
}
