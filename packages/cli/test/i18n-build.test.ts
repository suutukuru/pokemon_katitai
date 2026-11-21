import { describe, expect, it } from "vitest";
import { baseDex } from "@ca/data";
import { buildMoveMeta, buildNames, parseCsv } from "../src/i18n-build.js";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and empty fields", () => {
    expect(parseCsv('a,b,c\r\n1,"x, ""y""",\n2,z,3')).toEqual([
      { a: "1", b: 'x, "y"', c: "" },
      { a: "2", b: "z", c: "3" },
    ]);
    expect(parseCsv("")).toEqual([]);
  });
});

const csv = {
  pokemon_species: "id,identifier\n6,charizard\n9999,notamon",
  pokemon_species_names:
    "pokemon_species_id,local_language_id,name,genus\n6,1,リザードン,\n6,9,Charizard,\n9999,9,Notamon,",
  moves:
    "id,identifier,accuracy,pp,priority,target_id,effect_chance\n157,rock-slide,90,10,0,11,30\n11,vice-grip,100,30,0,10,\n999,tachyon-cutter,0,10,0,10,",
  move_names:
    "move_id,local_language_id,name\n157,1,いわなだれ\n157,9,Rock Slide\n11,9,Vise Grip\n999,9,Tachyon Cutter",
  abilities: "id,identifier\n66,blaze",
  ability_names: "ability_id,local_language_id,name\n66,1,もうか\n66,9,Blaze",
  items: "id,identifier\n1,charizardite-y",
  item_names: "item_id,local_language_id,name\n1,1,リザードナイトＹ\n1,9,Charizardite Y",
  natures: "id,identifier\n1,modest",
  nature_names: "nature_id,local_language_id,name\n1,1,ひかえめ\n1,9,Modest",
  types: "id,identifier\n10,fire\n10001,unknown",
  type_names: "type_id,local_language_id,name\n10,1,ほのお\n10,9,Fire\n10001,9,???",
};

describe("buildNames", () => {
  const { names, missingJa } = buildNames(
    csv,
    [
      {
        id: "raichualola",
        code: "0026-001",
        en: "Raichu (Alolan Form)",
        ja: "ライチュウ (アローラのすがた)",
      },
    ],
    baseDex(),
    { version: "t", sources: [] },
  );
  it("keeps dex IDs only, NFKC-normalizes ja and prefers official species names", () => {
    expect(names.species).toEqual({
      charizard: { ja: "リザードン", en: "Charizard" },
      raichualola: { ja: "ライチュウ (アローラのすがた)", en: "Raichu (Alolan Form)" },
    });
    expect(names.items["charizarditey"]).toEqual({ ja: "リザードナイトY", en: "Charizardite Y" });
    expect(names.moves["visegrip"]).toEqual({ en: "Vise Grip" });
    expect(names.types).toEqual({ fire: { ja: "ほのお", en: "Fire" } });
    expect(missingJa.moves).toEqual(["tachyoncutter", "visegrip"]);
  });
});

describe("buildMoveMeta", () => {
  it("maps accuracy (0 → cannot miss), target and secondary chance", () => {
    const m = buildMoveMeta(
      csv.moves,
      "id,identifier\n10,selected-pokemon\n11,all-opponents",
      baseDex(),
      { version: "t", sources: [] },
    );
    expect(m.moves["rockslide"]).toEqual({
      accuracy: 90,
      pp: 10,
      priority: 0,
      target: "all-opponents",
      effectChance: 30,
    });
    expect(m.moves["tachyoncutter"]?.accuracy).toBeNull();
    expect(m.moves["visegrip"]?.effectChance).toBeNull();
  });
});
