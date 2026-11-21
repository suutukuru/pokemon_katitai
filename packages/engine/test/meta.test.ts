import { describe, expect, it } from "vitest";
import type { TeamRecord } from "@ca/schema";
import { archetypeRules, baseDex, queryTeams } from "@ca/data";
import { readTeamDbFiles } from "@ca/data/node";
import { classifyArchetypes, metaStats } from "../src/index.js";

const team = (members: { species: string; item?: string }[], season = "M-7"): TeamRecord => ({
  id: Math.random().toString(),
  season,
  format: "doubles",
  members,
  published: { items: true, moves: false, sp: false, abilities: false },
  leads: [],
  source: { title: "t" },
});

describe("classifyArchetypes", () => {
  it("item-determined conditions are computed, species-only are estimated (heuristic evidence)", () => {
    const sun = classifyArchetypes([{ species: "charizard", item: "charizarditey" }]);
    expect(sun).toEqual([expect.objectContaining({ id: "sun", basis: "computed" })]);
    expect(sun[0]!.evidence.kind).toBe("calc");
    const rain = classifyArchetypes([{ species: "pelipper" }]);
    expect(rain.map((a) => [a.id, a.basis])).toEqual([
      ["rain", "estimated"],
      ["tailwind", "estimated"],
    ]);
    expect(rain[0]!.evidence).toMatchObject({
      kind: "heuristic",
      rationale: expect.stringContaining("あめふらし"),
    });
    expect(classifyArchetypes([{ species: "charizard", item: "charizarditex" }])).toEqual([]);
  });
  it("all archetype rule IDs exist in the dex", () => {
    const dex = baseDex();
    for (const a of archetypeRules().archetypes)
      for (const c of a.conditions) {
        if (c.species) expect(dex.species(c.species), c.species).toBeDefined();
        if (c.item) expect(dex.hasItem(c.item), c.item).toBe(true);
      }
  });
});

describe("metaStats", () => {
  it("counts species, items, pairs and archetypes deterministically", () => {
    const m = metaStats([
      team([
        { species: "charizard", item: "charizarditey" },
        { species: "whimsicott", item: "focussash" },
      ]),
      team([{ species: "charizard", item: "charizarditex" }, { species: "pelipper" }]),
    ]);
    expect(m.teams).toBe(2);
    expect(m.species[0]).toEqual({
      id: "charizard",
      count: 2,
      share: 1,
      items: [
        { id: "charizarditex", count: 1 },
        { id: "charizarditey", count: 1 },
      ],
    });
    expect(m.species.find((s) => s.id === "pelipper")!.items).toEqual([{ id: "(none)", count: 1 }]);
    expect(m.pairs.map((p) => `${p.a}+${p.b}`)).toEqual([
      "charizard+pelipper",
      "charizard+whimsicott",
    ]);
    expect(m.archetypes).toEqual([
      { id: "tailwind", count: 2, share: 1 },
      { id: "rain", count: 1, share: 0.5 },
      { id: "sun", count: 1, share: 0.5 },
    ]);
    expect(metaStats([]).teams).toBe(0);
  });
  it("golden: M-5..M-7 doubles top teams", () => {
    const m = metaStats(queryTeams(readTeamDbFiles(), { format: "doubles", seasons: [5, 7] }));
    expect(m.teams).toBe(45);
    expect(m.species.slice(0, 4).map((s) => [s.id, s.count])).toEqual([
      ["sneasler", 14],
      ["kingambit", 13],
      ["archaludon", 12],
      ["charizard", 12],
    ]);
    expect(m.pairs[0]).toMatchObject({ a: "archaludon", b: "pelipper", count: 9 });
  });
});
