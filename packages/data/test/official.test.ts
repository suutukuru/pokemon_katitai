import { describe, expect, it } from "vitest";
import {
  baseDex,
  importOfficialSpecies,
  officialEnglishToId,
  parseOfficialPokemonPage,
} from "../src/index.js";
import en from "../sources/official/rs178713870219xeaaio.pokemon.en.json" with { type: "json" };
import ja from "../sources/official/rs178713870219xeaaio.pokemon.ja.json" with { type: "json" };
import type { OfficialPokemonEntry } from "../src/index.js";

describe("official Champions pokemon page", () => {
  it("extracts the embedded list", () => {
    const html =
      '<script>const pokemons = [["0006-000",1,"Charizard"],["0026-001",1,"Raichu (Alolan Form)"]];</script>';
    expect(parseOfficialPokemonPage(html)).toEqual([
      ["0006-000", 1, "Charizard"],
      ["0026-001", 1, "Raichu (Alolan Form)"],
    ]);
    expect(() => parseOfficialPokemonPage("<html></html>")).toThrow(/not found/);
    expect(() => parseOfficialPokemonPage('const pokemons = [["x"]];')).toThrow(/unexpected/);
  });

  it("maps official form names to Showdown IDs", () => {
    expect(officialEnglishToId("Raichu (Alolan Form)")).toBe("raichualola");
    expect(officialEnglishToId("Tauros (Paldean Form (Aqua Breed))")).toBe("taurospaldeaaqua");
    expect(officialEnglishToId("Rotom (Wash Rotom)")).toBe("rotomwash");
    expect(officialEnglishToId("Rotom (Rotom)")).toBe("rotom");
    expect(officialEnglishToId("Gourgeist (Jumbo Variety)")).toBe("gourgeistsuper");
    expect(officialEnglishToId("Toxtricity (Low Key Form)")).toBe("toxtricitylowkey");
    expect(officialEnglishToId("Kommo-o")).toBe("kommoo");
    expect(officialEnglishToId("Foo (Weird Form)")).toBeUndefined();
  });

  it("resolves every entry of the saved snapshot except Aegislash (missing from Gen 9 data)", () => {
    const r = importOfficialSpecies(
      en as OfficialPokemonEntry[],
      ja as OfficialPokemonEntry[],
      baseDex(),
    );
    expect(r.unresolved).toEqual(["0681-000 Aegislash"]);
    expect(r.species).toHaveLength(261);
    expect(new Set(r.species.map((s) => s.id)).size).toBe(261);
    expect(r.species.find((s) => s.code === "0931-002")?.id).toBe("squawkabillyyellow");
    expect(r.species.find((s) => s.id === "meowsticf")?.ja).toBe("ニャオニクス (メスのすがた)");
  });
});
