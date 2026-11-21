import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PokemonSetSchema } from "@ca/schema";
import { loadPack } from "@ca/data";
import { CalcError, ChampionsCalc, distributionOf, type Weather } from "../src/index.js";
import cases from "./golden/damage-cases.json" with { type: "json" };
import { referenceRolls } from "./reference-formula.js";
import { calc, pack, spec, team } from "./helpers.js";
import { childOf, TestSource } from "../../data/test/helpers.js";

describe("golden: damage (adapter vs independent reference formula)", () => {
  expect(cases.cases.length).toBeGreaterThanOrEqual(10);
  for (const c of cases.cases) {
    it(c.id, () => {
      const r = calc.damage(
        { set: team[c.attacker]!, mega: "attackerMega" in c ? c.attackerMega : false },
        { set: team[c.defender]! },
        c.move,
        "weather" in c ? { weather: c.weather as Weather } : {},
      );
      expect([r.attackerStats.atk, r.attackerStats.spa]).toContain(c.A);
      const weatherMod = "weatherMod" in c ? c.weatherMod : "weather" in c ? 1.5 : undefined;
      const expected = referenceRolls({
        ...c,
        ...(weatherMod !== undefined ? { weatherMod } : {}),
      });
      const rolls = r.distribution.flatMap(
        (d) => Array(Math.round(d.p * 16)).fill(d.damage) as number[],
      );
      expect(rolls).toEqual(expected);
      expect(r.min).toBe(expected[0]);
      expect(r.max).toBe(expected[15]);
    });
  }
});

describe("damage result fields", () => {
  const meow = team["meowscarada"]!;
  const hippo = team["hippowdon"]!;
  const zard = team["charizard"]!;
  const whimsi = team["whimsicott"]!;

  it("always-crit moves report critChance 1 and identical crit/non-crit KO odds", () => {
    const r = calc.damage({ set: meow }, { set: hippo }, "flowertrick");
    expect(r.critChance).toBe(1);
    expect(r.accuracy).toBe(1);
    expect(r.ohko.noCrit).toBe(r.ohko.crit);
    expect(r.percent[0]).toBeLessThanOrEqual(r.percent[1]);
  });

  it("combines accuracy and crit chance into the one-hit KO probability", () => {
    // Spread Rock Slide (90% acc) into Charizard: 4x, OHKO on 10/16 rolls, always on a crit
    const r = calc.damage({ set: team["aerodactyl"]! }, { set: zard }, "rockslide");
    expect(r.ohko).toEqual({ noCrit: 0.625, crit: 1 });
    expect(r.accuracy).toBe(0.9);
    expect(r.koChanceOneHit).toBeCloseTo(0.9 * ((23 / 24) * 0.625 + 1 / 24));
    expect(r.nhko.n).toBe(1);
  });

  it("partial KO chance uses both crit and non-crit distributions", () => {
    const r = calc.damage({ set: zard }, { set: meow }, "heatwave");
    const c = 1 / 24;
    expect(r.koChanceOneHit).toBeCloseTo(0.9 * ((1 - c) * r.ohko.noCrit + c * r.ohko.crit));
    expect(r.ohko.crit).toBeGreaterThanOrEqual(r.ohko.noCrit);
  });

  it("multi-hit moves produce a convolved total distribution summing to 1", () => {
    const r = calc.damage({ set: meow }, { set: zard }, "tripleaxel");
    expect(r.distribution.reduce((a, d) => a + d.p, 0)).toBeCloseTo(1);
    expect(r.distribution.length).toBeGreaterThan(16);
    const bs = calc.damage({ set: meow }, { set: zard }, "seedbomb");
    expect(bs.min).toBeLessThan(bs.max);
  });

  it("status moves and immunities yield zero damage", () => {
    expect(calc.damage({ set: whimsi }, { set: meow }, "tailwind").max).toBe(0);
    const r = calc.damage({ set: hippo }, { set: zard }, "highhorsepower");
    expect(r.max).toBe(0);
    expect(r.koChanceOneHit).toBe(0);
  });

  it("current HP lowers the bar for a KO", () => {
    const full = calc.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower");
    const low = calc.damage({ set: hippo }, { set: team["milotic"]!, curHp: 40 }, "highhorsepower");
    expect(full.ohko.noCrit).toBe(0);
    expect(low.ohko.noCrit).toBe(1);
    expect(low.defenderHp).toBe(40);
  });

  it("screens, helping hand and status are passed through", () => {
    const base = calc.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower");
    const reflect = calc.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower", {
      defenderSide: { reflect: true },
    });
    const hh = calc.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower", {
      attackerSide: { helpingHand: true },
    });
    const burned = calc.damage(
      { set: hippo, status: "brn" },
      { set: team["milotic"]! },
      "highhorsepower",
    );
    const boosted = calc.damage(
      { set: hippo, boosts: { atk: 1 } },
      { set: team["milotic"]! },
      "highhorsepower",
    );
    expect(reflect.max).toBeLessThan(base.max);
    expect(hh.max).toBeGreaterThan(base.max);
    expect(burned.max).toBeLessThan(base.max);
    expect(boosted.max).toBeGreaterThan(base.max);
    const terrain = calc.damage({ set: meow }, { set: team["milotic"]! }, "flowertrick", {
      terrain: "Grassy",
    });
    expect(terrain.max).toBeGreaterThan(
      calc.damage({ set: meow }, { set: team["milotic"]! }, "flowertrick").max,
    );
  });

  it("Mega Evolution uses the Mega forme's stats and ability", () => {
    const r = calc.damage({ set: zard, mega: true }, { set: meow }, "heatwave");
    expect(calc.formeOf({ set: zard, mega: true })).toBe("charizardmegay");
    expect(r.attackerStats.spa).toBe(196);
    expect(() => calc.formeOf({ set: meow, mega: true })).toThrow(CalcError);
  });

  it("rejects illegal SP spreads, unknown moves and species", () => {
    const bad = { ...meow, sp: { ...meow.sp, hp: 10 } };
    expect(() => calc.damage({ set: bad }, { set: hippo }, "flowertrick")).toThrow(
      /exceeds the cap 66/,
    );
    expect(() => calc.damage({ set: meow }, { set: hippo }, "notamove")).toThrow(/unknown move/);
    expect(() => calc.baseStats("notamon")).toThrow(/unknown species/);
  });

  it("label() gives Japanese names", () => {
    expect(calc.label("meowscarada")).toBe("マスカーニャ");
    expect(calc.label("meowscarada", "en")).toBe("Meowscarada");
  });
});

describe("regulation overrides flow into the calc", () => {
  const s = new TestSource();
  s.packs["Z-1"] = childOf("M-C", "Z-1", {
    overrides: {
      moves: {
        highhorsepower: { basePower: 190, verified: false },
        rockslide: { accuracy: 100, verified: false },
      },
      species: { hippowdon: { baseStats: { atk: 200 }, verified: false } },
    },
    legal: { bannedMoves: { add: ["slackoff"] } },
  });
  const z = new ChampionsCalc(loadPack(s, "Z-1"), spec);
  const hippo = team["hippowdon"]!;

  it("move power, accuracy and species base stats are overridden", () => {
    const base = calc.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower");
    const over = z.damage({ set: hippo }, { set: team["milotic"]! }, "highhorsepower");
    expect(over.max).toBeGreaterThan(base.max * 2);
    expect(z.stats({ set: hippo }).atk).toBeGreaterThan(calc.stats({ set: hippo }).atk);
    expect(
      z.damage({ set: team["aerodactyl"]! }, { set: team["charizard"]! }, "rockslide").accuracy,
    ).toBe(1);
  });
  it("banned moves are rejected", () => {
    expect(() => z.damage({ set: hippo }, { set: team["milotic"]! }, "slackoff")).toThrow(/banned/);
  });
  it("newSpecies from the pack are usable (Aegislash in M-C)", () => {
    const aegi = PokemonSetSchema.parse({
      species: "aegislash",
      ability: "Stance Change",
      nature: "Quiet",
      moves: ["Shadow Ball"],
      sp: { hp: 32, atk: 0, def: 0, spa: 32, spd: 2, spe: 0 },
    });
    expect(calc.stats({ set: aegi }).def).toBe(calcDef());
    expect(calc.damage({ set: aegi }, { set: team["milotic"]! }, "shadowball").max).toBeGreaterThan(
      0,
    );
    function calcDef() {
      return Math.floor((Math.floor((2 * 140 + 31) / 2) + 0 + 5) * 1);
    }
  });
  it("mega requires the mechanic", () => {
    const s2 = new TestSource();
    s2.packs["Z-2"] = childOf("M-C", "Z-2", {
      manifest: {
        id: "Z-2",
        name: { ja: "z", en: "z" },
        extends: "M-C",
        dataVersion: "t",
        verified: false,
        mechanics: { remove: ["mega"] },
      },
      legal: { megaSpecies: { remove: pack.legal.megaSpecies } },
    });
    const noMega = new ChampionsCalc(loadPack(s2, "Z-2"), spec);
    expect(() => noMega.formeOf({ set: team["charizard"]!, mega: true })).toThrow(
      /does not enable Mega/,
    );
  });
});

describe("distributionOf", () => {
  it("handles fixed damage and per-hit arrays", () => {
    expect(distributionOf(0)).toEqual([{ damage: 0, p: 1 }]);
    expect(distributionOf([[1, 2], [10]])).toEqual([
      { damage: 11, p: 0.5 },
      { damage: 12, p: 0.5 },
    ]);
  });
  it("property: probabilities sum to 1 and support is [Σmin, Σmax]", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.nat(50), { minLength: 1, maxLength: 4 }), {
          minLength: 1,
          maxLength: 3,
        }),
        (hits) => {
          const d = distributionOf(hits);
          expect(d.reduce((a, x) => a + x.p, 0)).toBeCloseTo(1);
          expect(d[0]!.damage).toBe(hits.reduce((a, h) => a + Math.min(...h), 0));
          expect(d.at(-1)!.damage).toBe(hits.reduce((a, h) => a + Math.max(...h), 0));
        },
      ),
    );
  });
});
