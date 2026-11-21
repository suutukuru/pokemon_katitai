import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FindingSchema, ManifestSchema, PokemonSetSchema, toID } from "../src/index.js";

describe("toID", () => {
  it("normalizes Showdown names", () => {
    expect(toID("Charizard-Mega-Y")).toBe("charizardmegay");
    expect(toID("Indeedee-F")).toBe("indeedeef");
    expect(toID("Farfetch’d")).toBe("farfetchd");
  });
  it("is idempotent and yields only [a-z0-9]", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const id = toID(s);
        expect(toID(id)).toBe(id);
        expect(id).toMatch(/^[a-z0-9]*$/);
      }),
    );
  });
});

const finding = {
  ruleId: "speed-control.missing",
  ruleVersion: 1,
  category: "speedControl",
  severity: "major",
  basis: "computed",
  score: 0.2,
  explainKey: "speedControl.missing",
  params: {},
  evidence: [{ kind: "calc", label: "speed", values: { count: 0 } }],
};

describe("FindingSchema", () => {
  it("accepts a finding with evidence", () => {
    expect(FindingSchema.parse(finding).suggestions).toEqual([]);
  });
  it("rejects a finding without evidence", () => {
    expect(FindingSchema.safeParse({ ...finding, evidence: [] }).success).toBe(false);
  });
  it("requires data evidence to carry a source", () => {
    const bad = { ...finding, evidence: [{ kind: "data", label: "usage", values: {} }] };
    expect(FindingSchema.safeParse(bad).success).toBe(false);
  });
  it("property: any parsed finding has >= 1 evidence item", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ kind: fc.constant("calc"), label: fc.string(), values: fc.constant({}) }),
        ),
        (ev) => {
          const r = FindingSchema.safeParse({ ...finding, evidence: ev });
          expect(r.success).toBe(ev.length > 0);
        },
      ),
    );
  });
});

describe("ManifestSchema", () => {
  const m = { id: "M-B", name: { ja: "a", en: "b" }, dataVersion: "1", verified: false };
  it("applies defaults", () => {
    expect(ManifestSchema.parse(m).mechanics).toEqual({ add: [], remove: [] });
  });
  it("rejects lowercase pack ids and unknown keys", () => {
    expect(ManifestSchema.safeParse({ ...m, id: "m-b" }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...m, extra: 1 }).success).toBe(false);
  });
  it("rejects periods ending before they start", () => {
    expect(
      ManifestSchema.safeParse({
        ...m,
        periods: { ranked: { start: "2026-02-01", end: "2026-01-01" } },
      }).success,
    ).toBe(false);
  });
});

describe("PokemonSetSchema", () => {
  it("normalizes IDs", () => {
    const p = PokemonSetSchema.parse({
      species: "Incineroar",
      ability: "Intimidate",
      nature: "Careful",
      sp: { hp: 32, atk: 0, def: 10, spa: 0, spd: 24, spe: 0 },
      moves: ["Fake Out", "Parting Shot"],
    });
    expect(p.species).toBe("incineroar");
    expect(p.moves).toEqual(["fakeout", "partingshot"]);
    expect(p.assumed).toEqual([]);
  });
});
