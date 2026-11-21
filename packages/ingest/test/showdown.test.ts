import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PokemonSetSchema, STAT_IDS } from "@ca/schema";
import { loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { formatShowdown, parseShowdown, ShowdownTextExtractor } from "../src/index.js";
import golden from "../../calc/test/golden/ingame-stats.json" with { type: "json" };

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const expected = golden.members.map((m) => PokemonSetSchema.parse(m.set));
const pack = loadPack(new FsPackSource(), "M-C");

describe("Japanese team text (the user's in-game team)", () => {
  const r = parseShowdown(fixture("user-team-1.ja.txt"), {
    legal: { species: pack.legal.species, items: pack.legal.items },
  });
  it("parses all six members with no issues", () => {
    expect(r.issues).toEqual([]);
    expect(r.members).toHaveLength(6);
  });
  it("matches the in-game golden sets exactly", () => {
    expect(r.members).toEqual(expected);
  });
});

describe("round trips", () => {
  it("en: format → parse is lossless", () => {
    const r = parseShowdown(formatShowdown(expected));
    expect(r.issues).toEqual([]);
    expect(r.members).toEqual(expected);
  });
  it("ja: format → parse is lossless", () => {
    expect(parseShowdown(formatShowdown(expected, "ja")).members).toEqual(expected);
  });
  it("property: any legal SP spread survives the round trip", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...expected),
        fc.record({
          hp: fc.nat(32),
          atk: fc.nat(32),
          def: fc.nat(32),
          spa: fc.nat(32),
          spd: fc.nat(32),
          spe: fc.nat(32),
        }),
        fc.option(fc.stringMatching(/^[A-Za-z]{1,10}$/), { nil: undefined }),
        (set, sp, nickname) => {
          const s = { ...set, sp, ...(nickname ? { nickname } : {}) };
          const back = parseShowdown(formatShowdown([s])).members[0]!;
          expect(back.sp).toEqual(sp);
          expect(back.nickname).toBe(nickname);
          expect(back.species).toBe(set.species);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("standard Showdown text", () => {
  const text = `Sparky (Incineroar) (M) @ Sitrus Berry
Ability: Intimidate
Level: 50
Tera Type: Grass
EVs: 252 HP / 4 Atk / 100 Def / 148 SpD
IVs: 0 Spe
Careful Nature
- Fake Out
- Flare Blitz
- Parting Shot
- Knock Off`;
  const r = parseShowdown(text);
  const m = r.members[0]!;
  it("parses header, ability, nature, moves", () => {
    expect(m).toMatchObject({
      nickname: "Sparky",
      species: "incineroar",
      gender: "M",
      item: "sitrusberry",
      ability: "intimidate",
      nature: "Careful",
      moves: ["fakeout", "flareblitz", "partingshot", "knockoff"],
    });
  });
  it("converts EVs to SP with a warning and lowered confidence", () => {
    expect(m.sp).toEqual({ hp: 32, atk: 1, def: 13, spa: 0, spd: 19, spe: 0 });
    expect(m.confidence["sp"]).toBe(0.9);
    expect(r.issues.some((i) => i.severity === "warning" && i.field === "sp")).toBe(true);
  });
  it("reports ignored mainline-only lines as info", () => {
    expect(r.issues.filter((i) => i.severity === "info").map((i) => i.line)).toEqual([3, 4, 6]);
  });
});

describe("name correction and errors", () => {
  it("fuzzy-matches a typo, lowers confidence and offers candidates", () => {
    const r = parseShowdown("マスカーニヤ\nAbility: Protean\n- Flower Trick");
    expect(r.members[0]!.species).toBe("meowscarada");
    expect(r.members[0]!.confidence["species"]).toBeLessThan(1);
    const w = r.issues.find((i) => i.field === "species")!;
    expect(w.severity).toBe("warning");
    expect(w.candidates?.[0]).toEqual({ id: "meowscarada", label: "マスカーニャ" });
  });
  it("rejects species outside the regulation and offers legal candidates", () => {
    const r = parseShowdown("Flutter Mane\nAbility: Protosynthesis\n- Moonblast", {
      legal: { species: pack.legal.species },
    });
    expect(r.members).toEqual([]);
    expect(r.issues[0]).toMatchObject({ severity: "error", field: "species" });
    expect(r.issues[0]!.candidates!.length).toBeGreaterThan(0);
  });
  it("drops unknown moves with an error but keeps the member", () => {
    const r = parseShowdown("Milotic\nAbility: Competitive\n- Scald\n- Zzzzzzzz");
    expect(r.members[0]!.moves).toEqual(["scald"]);
    expect(r.issues).toContainEqual(
      expect.objectContaining({ severity: "error", field: "moves.1" }),
    );
  });
  it("flags missing nature/SP as assumed", () => {
    const r = parseShowdown("Milotic\nAbility: Competitive\n- Scald");
    expect(r.members[0]!.assumed).toEqual(["nature", "sp"]);
    expect(r.members[0]!.nature).toBe("Serious");
    expect(STAT_IDS.every((s) => r.members[0]!.sp[s] === 0)).toBe(true);
  });
  it("requires an ability and at least one move", () => {
    expect(parseShowdown("Milotic\n- Scald").issues[0]?.message).toBe("特性がありません");
    expect(parseShowdown("Milotic\nAbility: Competitive").issues.at(-1)?.message).toBe(
      "技がありません",
    );
  });
  it("reports unreadable SP/EV lines and stray lines", () => {
    const r = parseShowdown(
      "Milotic\nAbility: Competitive\nSPs: lots\nEVs: many\nFoo: bar\nrandom text\n- Scald",
    );
    expect(r.issues.map((i) => i.severity)).toEqual([
      "error",
      "error",
      "warning",
      "warning",
      "warning",
      "warning",
    ]);
  });
  it("rejects more than six members", () => {
    const one = "Milotic\nAbility: Competitive\nSPs: 1 HP\nTimid Nature\n- Scald";
    expect(parseShowdown(Array(7).fill(one).join("\n\n")).issues.at(-1)?.message).toContain("7体");
  });
  it("reports schema violations (SP above the schema's int range is still parsed; moves > 4 fails)", () => {
    const r = parseShowdown(
      "Milotic\nAbility: Competitive\nSPs: 1 HP\nTimid Nature\n- Scald\n- Surf\n- Recover\n- Ice Beam\n- Protect",
    );
    expect(r.members).toEqual([]);
    expect(r.issues[0]?.severity).toBe("error");
  });
});

describe("ShowdownTextExtractor", () => {
  it("implements the Extractor interface", async () => {
    const r = await new ShowdownTextExtractor().extract(fixture("user-team-1.ja.txt"));
    expect(r.extractor).toBe("showdown-text");
    expect(r.members).toHaveLength(6);
  });
});

describe("gender formes", () => {
  it("(F) selects the female forme when it exists", () => {
    const r = parseShowdown(
      "イエッサン (F)\n特性: サイコメイカー\n- まもる\n\nイダイトウ (M)\n特性: すいすい\n- まもる",
    );
    expect(r.members.map((m) => m.species)).toEqual(["indeedeef", "basculegion"]);
    expect(parseShowdown("ミロカロス (F)\n特性: かちき\n- ねっとう").members[0]!.species).toBe(
      "milotic",
    );
  });
});
