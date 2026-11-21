import { describe, expect, it } from "vitest";
import {
  importPokedb,
  pokedbToOfficialCode,
  queryTeams,
  seasonNumber,
  parseTeamDbFile,
  loadPack,
} from "../src/index.js";
import { FsPackSource, readTeamDbFiles } from "../src/node.js";

const codeMap = new Map([
  ["0006-000", "charizard"],
  ["0670-005", "floetteeternal"],
  ["0902-001", "basculegionf"],
]);
const stones = (s: string) =>
  s === "floetteeternal"
    ? ["floettite"]
    : s === "charizard"
      ? ["charizarditex", "charizarditey"]
      : [];
const sample = {
  season: "M-7",
  season_number: 7,
  rule: "ダブル",
  updated_at: "2026-11-18 17:45:56",
  teams: [
    {
      rank: 4,
      rating_value: 2354.9,
      team: [
        { id: "0006-00", pokemon: "リザードン", form: "", item: "リザードナイトＹ" },
        {
          id: "0670-05",
          pokemon: "フラエッテ",
          form: "えいえんのはな",
          item: "ミライノフラエッテナイト",
        },
        { id: "0902-01", pokemon: "イダイトウ", form: "メスのすがた", item: "持ち物なし" },
      ],
    },
    {
      rank: 9,
      rating_value: null,
      team: [
        { id: "9999-00", pokemon: "なぞ", form: "", item: "ふしぎなアイテム" },
        { id: "0006-00", pokemon: "リザードン", form: "", item: "ふしぎなアイテム" },
      ],
    },
  ],
};

describe("pokedb open data import", () => {
  const r = importPokedb(sample, codeMap, "https://example.invalid/s7.json", stones);
  it("maps IDs, items, no-item, and records provenance", () => {
    const t = r.file.teams[0]!;
    expect(t).toMatchObject({
      id: "pokedb-M-7-doubles-4",
      season: "M-7",
      format: "doubles",
      rank: 4,
      rating: 2354.9,
      published: { items: true, moves: false },
    });
    expect(t.members).toEqual([
      { species: "charizard", item: "charizarditey" },
      { species: "floetteeternal", item: "floettite" },
      { species: "basculegionf" },
    ]);
    expect(r.file.license).toContain("L-07");
  });
  it("learns Mega Stone names from the holder", () => {
    expect(r.learnedItemNames).toEqual({ floettite: "ミライノフラエッテナイト" });
  });
  it("reports unknown species/items and null ratings", () => {
    expect(r.issues).toEqual([
      expect.stringContaining("unknown pokemon 9999-00"),
      expect.stringContaining('item "ふしぎなアイテム"'),
    ]);
    expect(r.file.teams[1]!.rating).toBeUndefined();
  });
  it("converts pokedb IDs to official codes", () => {
    expect(pokedbToOfficialCode("0479-02")).toBe("0479-002");
  });
});

describe("team database (committed open data)", () => {
  const files = readTeamDbFiles();
  const legal = loadPack(new FsPackSource(), "M-C").legal.species;
  it("loads every season file and all teams are M-C legal", () => {
    expect(files.map((f) => f.season)).toEqual(["M-1", "M-2", "M-3", "M-4", "M-5", "M-6", "M-7"]);
    const all = queryTeams(files, { format: "doubles" });
    expect(all.length).toBe(226);
    expect(queryTeams(files, { format: "doubles", legalSpecies: legal }).length).toBe(226);
  });
  it("filters by season range and sorts newest season, then rank", () => {
    const t = queryTeams(files, { seasons: [5, 7] });
    expect(new Set(t.map((x) => x.season))).toEqual(new Set(["M-5", "M-6", "M-7"]));
    expect(t[0]!.season).toBe("M-7");
    expect(seasonNumber("M-12")).toBe(12);
    expect(queryTeams(files, { format: "singles" })).toEqual([]);
  });
  it("validates files with zod", () => {
    expect(() => parseTeamDbFile({ dataset: "x" })).toThrow();
  });
});
