import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  displayName,
  levenshtein,
  moveMeta,
  names,
  normalizeName,
  resolveName,
} from "../src/index.js";

describe("name table", () => {
  it("has ja/en for the user's team and Champions additions", () => {
    expect(names().species["meowscarada"]).toEqual({ ja: "マスカーニャ", en: "Meowscarada" });
    expect(names().species["aegislash"]?.ja).toBe("ギルガルド");
    expect(displayName("moves", "highhorsepower")).toBe("10まんばりき");
    expect(displayName("items", "charizarditey")).toBe("リザードナイトY");
    expect(displayName("moves", "flowertrick", "en")).toBe("Flower Trick");
    expect(displayName("moves", "notamove")).toBe("notamove");
  });
  it("names Mega formes from their base species", () => {
    expect(displayName("species", "charizardmegay")).toBe("メガリザードンY");
    expect(displayName("species", "charizardmegay", "en")).toBe("Charizard-Mega-Y");
    expect(displayName("species", "aerodactylmega")).toBe("メガプテラ");
  });
  it("exposes move accuracy", () => {
    expect(moveMeta("rockslide")?.accuracy).toBe(90);
    expect(moveMeta("flowertrick")?.accuracy).toBeNull();
  });
});

describe("normalizeName / levenshtein", () => {
  it("folds width, kana and punctuation", () => {
    expect(normalizeName("リザードナイトＹ")).toBe(normalizeName("りざーどないとy"));
    expect(normalizeName("Mr. Mime")).toBe("mrmime");
  });
  it("levenshtein basics and symmetry", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 }), (a, b) => {
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
        expect(levenshtein(a, a)).toBe(0);
      }),
    );
  });
});

describe("resolveName", () => {
  it("matches ja/en/ID exactly", () => {
    for (const t of ["マスカーニャ", "ますかーにゃ", "Meowscarada", "meowscarada"]) {
      expect(resolveName("species", t)).toMatchObject({
        id: "meowscarada",
        kind: "exact",
        confidence: 1,
      });
    }
  });
  it("fuzzy-matches typos with lower confidence", () => {
    const r = resolveName("moves", "トリックフラワ");
    expect(r).toMatchObject({ id: "flowertrick", kind: "fuzzy" });
    expect(r.confidence).toBeLessThan(1);
  });
  it("refuses to guess when nothing is close, but still offers candidates", () => {
    const r = resolveName("species", "ニャオニクス（メス）");
    expect(r.kind).toBe("none");
    expect(r.candidates[0]?.id).toBe("meowsticf");
    expect(resolveName("species", "   ").kind).toBe("none");
  });
  it("restricts to an allowed set and accepts IDs outside the name table", () => {
    expect(resolveName("species", "Charizard", { within: ["milotic"] }).id).not.toBe("charizard");
    expect(
      resolveName("species", "Charizard-Mega-Y", { within: ["charizardmegay"] }),
    ).toMatchObject({ id: "charizardmegay", kind: "exact" });
  });
});
