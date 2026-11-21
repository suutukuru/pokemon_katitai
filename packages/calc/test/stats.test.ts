import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STAT_IDS, type StatId, type StatsTable } from "@ca/schema";
import {
  calcStat,
  calcStats,
  evToSp,
  inferSp,
  natureEffect,
  natureFrom,
  spToEv,
  validateSp,
} from "../src/index.js";
import { calc, observed, spec, team } from "./helpers.js";

describe("golden: in-game stats (user screenshots, regulation M-C)", () => {
  for (const [species, set] of Object.entries(team)) {
    it(`${species}: all six stats match the game`, () => {
      expect(calc.stats({ set })).toEqual(observed[species]);
    });
  }
  it("every spread uses exactly the SP cap and respects the per-stat cap", () => {
    for (const set of Object.values(team)) {
      expect(STAT_IDS.reduce((a, s) => a + set.sp[s], 0)).toBe(spec.statPoints.total.value);
      expect(validateSp(spec, set.sp)).toEqual([]);
    }
  });
  it("inferSp recovers each SP value from the observed stat", () => {
    for (const [species, set] of Object.entries(team)) {
      const base = calc.baseStats(species);
      for (const s of STAT_IDS)
        expect(inferSp(spec, s, base[s], observed[species]![s]!, set.nature)).toContain(set.sp[s]);
    }
  });
});

describe("natures", () => {
  it("maps screenshot arrows to natures", () => {
    expect(natureFrom("spa", "atk")).toBe("Modest");
    expect(natureFrom("spe", "atk")).toBe("Timid");
    expect(natureFrom("spe", "spa")).toBe("Jolly");
    expect(natureFrom("def", "spa")).toBe("Impish");
    expect(natureFrom("atk", "spa")).toBe("Adamant");
    expect(natureFrom(undefined, undefined)).toBe("Serious");
    expect(() => natureFrom("atk", "atk")).toThrow();
    expect(natureEffect("Hardy", "atk")).toBe(0);
    expect(() => natureEffect("Nope", "atk")).toThrow(/unknown nature/);
  });
});

describe("SP validation and EV conversion", () => {
  it("reports caps", () => {
    const sp: StatsTable = { hp: 33, atk: 32, def: 2, spa: 0, spd: 0, spe: 0 };
    expect(validateSp(spec, sp).map((i) => i.message)).toEqual([
      "SP 33 exceeds the per-stat cap 32",
      "SP total 67 exceeds the cap 66",
    ]);
    expect(validateSp(spec, { ...sp, hp: -1 })[0]?.stat).toBe("hp");
  });
  it("EV ⇔ SP round-trips and reproduces the Lv50 stat", () => {
    expect([spToEv(0), spToEv(1), spToEv(32), evToSp(252), evToSp(4), evToSp(0)]).toEqual([
      0, 4, 252, 32, 1, 0,
    ]);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 32 }), (sp) => {
        expect(evToSp(spToEv(sp))).toBe(sp);
      }),
    );
  });
  it("HP of Shedinja is always 1", () => {
    expect(calcStat(spec, "hp", 1, 32, "Hardy")).toBe(1);
  });
});

describe("properties", () => {
  const stat = fc.constantFrom<StatId>(...STAT_IDS);
  const nature = fc.constantFrom(
    "Hardy",
    "Adamant",
    "Modest",
    "Timid",
    "Jolly",
    "Bold",
    "Brave",
    "Quiet",
  );
  it("more SP never lowers a stat (and so never worsens speed order)", () => {
    fc.assert(
      fc.property(
        stat,
        fc.integer({ min: 1, max: 255 }),
        fc.integer({ min: 0, max: 31 }),
        nature,
        (s, base, sp, n) => {
          expect(calcStat(spec, s, base, sp + 1, n)).toBeGreaterThanOrEqual(
            calcStat(spec, s, base, sp, n),
          );
        },
      ),
    );
  });
  it("a raising nature never lowers the stat vs neutral, a lowering one never raises it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 255 }), fc.integer({ min: 0, max: 32 }), (base, sp) => {
        const neutral = calcStat(spec, "spe", base, sp, "Hardy");
        expect(calcStat(spec, "spe", base, sp, "Timid")).toBeGreaterThanOrEqual(neutral);
        expect(calcStat(spec, "spe", base, sp, "Brave")).toBeLessThanOrEqual(neutral);
      }),
    );
  });
  it("matches @smogon/calc's mainline formula under the SP→EV mapping", async () => {
    const { Generations, Pokemon } = await import("@smogon/calc");
    const gen = Generations.get(9);
    fc.assert(
      fc.property(
        fc.constantFrom(
          "charizard",
          "incineroar",
          "garchomp",
          "whimsicott",
          "hippowdon",
          "milotic",
        ),
        fc.record({
          hp: fc.nat(32),
          atk: fc.nat(32),
          def: fc.nat(32),
          spa: fc.nat(32),
          spd: fc.nat(32),
          spe: fc.nat(32),
        }),
        nature,
        (species, sp, n) => {
          const p = new Pokemon(gen, gen.species.get(species as never)!.name, {
            level: 50,
            nature: n,
            evs: Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, spToEv(v)])),
          });
          expect(calcStats(spec, p.species.baseStats as StatsTable, sp, n)).toEqual(p.rawStats);
        },
      ),
      { numRuns: 300 },
    );
  });
});
