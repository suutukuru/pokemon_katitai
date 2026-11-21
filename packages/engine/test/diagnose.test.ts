import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SEVERITY_ORDER, type UsageSnapshot } from "@ca/schema";
import { calcStat } from "@ca/calc";
import { explainFinding } from "@ca/explain";
import {
  diagnose,
  RULES,
  RuleParamError,
  activeMechanics,
  megaMechanic,
  combinations,
  speedBenchmarks,
  RuleContext,
} from "../src/index.js";
import { mon, NOW, pack, sampleTeam, spec, withWeights } from "./helpers.js";

const TEAMS = ["user-team-1", "sample-trickroom", "sample-rain"] as const;

describe("phase 3 acceptance: three teams → evidence-backed findings sorted by severity", () => {
  for (const id of TEAMS) {
    it(id, () => {
      const r = diagnose(sampleTeam(id), pack, spec, { now: NOW });
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) {
        expect(f.evidence.length).toBeGreaterThan(0);
        const e = explainFinding(f);
        expect(e.title.length).toBeGreaterThan(0);
        expect(e.body).not.toMatch(/\{|\}|undefined/);
      }
      const order = r.findings.map((f) => SEVERITY_ORDER[f.severity]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(r.meta).toMatchObject({
        regulationId: "M-C",
        contentHash: pack.contentHash,
        engineVersion: expect.any(String),
      });
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(100);
    });
  }

  it("golden: findings are stable (snapshot)", () => {
    const out = Object.fromEntries(
      TEAMS.map((id) => {
        const r = diagnose(sampleTeam(id), pack, spec, { now: NOW });
        return [
          id,
          {
            score: r.score,
            findings: r.findings.map(
              (f) => `${f.severity} ${f.explainKey} ${JSON.stringify(f.params)}`,
            ),
          },
        ];
      }),
    );
    expect({ contentHash: pack.contentHash, ...out }).toMatchSnapshot();
  });

  it("is deterministic and runs well under a second", () => {
    const team = sampleTeam("user-team-1");
    const t0 = performance.now();
    const a = diagnose(team, pack, spec, { now: NOW });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(diagnose(team, pack, spec, { now: NOW })).toEqual(a);
  });
});

describe("findings on the user's team", () => {
  const r = diagnose(sampleTeam("user-team-1"), pack, spec, { now: NOW });
  const keys = r.findings.map((f) => f.explainKey);
  it("flags Drought (Mega Charizard Y) vs Sand Stream (Hippowdon)", () => {
    const f = r.findings.find((x) => x.explainKey === "field.conflict.weather")!;
    expect(f.params["setters"]).toBe("hippowdon:sandstream,charizard:drought");
    expect(explainFinding(f).body).toContain("カバルドンのすなおこし、リザードンのひでり");
  });
  it("flags the shared Ice weakness", () => {
    const f = r.findings.find(
      (x) => x.explainKey === "defense.sharedWeakness" && x.params["type"] === "Ice",
    )!;
    expect(f.params["weakCount"]).toBe(4);
    expect(explainFinding(f).body).toContain("こおり技が4匹");
  });
  it("notes missing Fake Out / Intimidate, and computes everything (no estimates)", () => {
    expect(keys).toEqual(
      expect.arrayContaining(["support.fakeout.missing", "support.intimidate.missing"]),
    );
    expect(r.findings.every((f) => f.basis === "computed")).toBe(true);
  });
  it("uses Mega formes for stats when holding a stone", () => {
    expect(r.members.find((m) => m.species === "charizard")).toMatchObject({
      forme: "charizardmegay",
      mega: true,
    });
    expect(r.members.find((m) => m.species === "aerodactyl")?.forme).toBe("aerodactylmega");
  });
});

describe("legality", () => {
  it("reports illegal species/items, clauses and SP caps as critical", () => {
    const team = [
      mon({ species: "fluttermane", ability: "protosynthesis", moves: ["moonblast"] }),
      mon({
        species: "milotic",
        ability: "competitive",
        item: "leftovers",
        moves: ["scald"],
        sp: { hp: 32, atk: 32, def: 32, spa: 0, spd: 0, spe: 0 },
      }),
      mon({ species: "milotic", ability: "competitive", item: "leftovers", moves: ["scald"] }),
      mon({ species: "pelipper", ability: "drizzle", item: "boosterenergy", moves: ["hurricane"] }),
    ];
    const r = diagnose(team, pack, spec, { now: NOW });
    const legal = r.findings.filter((f) => f.ruleId === "legality.team");
    expect(legal.map((f) => f.explainKey).sort()).toEqual([
      "legality.item",
      "legality.itemClause",
      "legality.sp",
      "legality.species",
      "legality.speciesClause",
    ]);
    expect(legal.every((f) => f.severity === "critical")).toBe(true);
    expect(r.findings[0]!.severity).toBe("critical");
  });
});

describe("speed suggestions are verified by the stat formula", () => {
  it("each suggestion's newSpeed equals calcStat with the added SP", () => {
    // Garchomp 102 base: a neutral 28-SP Garchomp sits just under several max-Speed tiers
    const team = [
      mon({
        species: "garchomp",
        ability: "roughskin",
        nature: "Adamant",
        moves: ["earthquake", "protect"],
        sp: { hp: 6, atk: 32, def: 0, spa: 0, spd: 0, spe: 28 },
      }),
    ];
    const r = diagnose(team, pack, spec, { now: NOW });
    const f = r.findings.find((x) => x.explainKey === "speed.nearTier");
    expect(f).toBeDefined();
    const add = f!.params["add"] as number;
    expect(f!.params["newSpeed"]).toBe(calcStat(spec, "spe", 102, 28 + add, "Adamant"));
    expect(f!.suggestions[0]!.explainKey).toBe("speed.suggest.move");
    expect(explainFinding(f!).suggestions[0]!.body).toContain("こうげき");
  });
  it("benchmarks include legal Mega formes", () => {
    const b = speedBenchmarks(new RuleContext([], pack, spec));
    expect(b.some((x) => x.species === "aerodactylmega")).toBe(true);
    expect(b[0]!.speed).toBeGreaterThanOrEqual(b.at(-1)!.speed);
  });
});

describe("other rules", () => {
  it("coverage counts -ate abilities of the Mega forme (Mega Gardevoir Pixilate → Fairy Hyper Voice)", () => {
    const g = mon({
      species: "gardevoir",
      ability: "trace",
      item: "gardevoirite",
      moves: ["hypervoice"],
    });
    const ctx = new RuleContext([g], pack, spec);
    expect(ctx.attackingMoves(g)).toEqual([{ id: "hypervoice", type: "Fairy" }]);
    expect(ctx.attackingMoves({ ...g, item: "leftovers" })).toEqual([
      { id: "hypervoice", type: "Normal" },
    ]);
  });
  it("does not suggest speeding up deliberately slow members", () => {
    const slow = mon({
      species: "garchomp",
      ability: "roughskin",
      nature: "Brave",
      moves: ["earthquake"],
      sp: { hp: 32, atk: 32, def: 0, spa: 0, spd: 0, spe: 2 },
    });
    expect(
      diagnose([slow], pack, spec, { now: NOW }).findings.map((f) => f.explainKey),
    ).not.toContain("speed.nearTier");
  });
  it("speed control: none vs weak-only", () => {
    const none = diagnose(
      [mon({ species: "milotic", ability: "competitive", moves: ["scald"] })],
      pack,
      spec,
      { now: NOW },
    );
    expect(none.findings.map((f) => f.explainKey)).toContain("speedControl.none");
    const weak = diagnose(
      [mon({ species: "milotic", ability: "competitive", moves: ["icywind"] })],
      pack,
      spec,
      { now: NOW },
    );
    expect(weak.findings.map((f) => f.explainKey)).toContain("speedControl.weakOnly");
  });
  it("mega: too many holders and none", () => {
    const team = ["charizard:charizarditey", "gengar:gengarite", "garchomp:garchompite"].map(
      (x) => {
        const [s, i] = x.split(":");
        return mon({ species: s!, ability: "pressure", item: i!, moves: ["protect"] });
      },
    );
    expect(diagnose(team, pack, spec, { now: NOW }).findings.map((f) => f.explainKey)).toContain(
      "mega.tooMany",
    );
    expect(
      diagnose(
        [team[0]!].map((m) => ({ ...m, item: "leftovers" })),
        pack,
        spec,
        { now: NOW },
      ).findings.map((f) => f.explainKey),
    ).toContain("mega.none");
  });
  it("selection: functional brings and an essential member", () => {
    const base = (s: string, moves: string[]) => mon({ species: s, ability: "pressure", moves });
    const team = [
      base("whimsicott", ["tailwind", "protect"]),
      base("milotic", ["scald", "protect"]),
      base("garchomp", ["earthquake", "protect"]),
      base("gengar", ["shadowball"]),
      base("kingambit", ["kowtowcleave"]),
      base("dragonite", ["extremespeed"]),
    ];
    const r = diagnose(team, pack, spec, { now: NOW });
    const f = r.findings.find((x) => x.ruleId === "selection.flexibility")!;
    expect(f.explainKey).toBe("selection.essential");
    expect(f.params).toMatchObject({ good: 9, total: 15, essential: "whimsicott" });
    const noProtect = team.map((m) =>
      m.species === "whimsicott" ? m : { ...m, moves: m.moves.filter((x) => x !== "protect") },
    );
    const g = diagnose(noProtect, pack, spec, { now: NOW }).findings.find(
      (x) => x.ruleId === "selection.flexibility",
    )!;
    expect(g).toMatchObject({ explainKey: "selection.inflexible", params: { good: 0, total: 15 } });
    expect(combinations([1, 2, 3, 4, 5, 6], 4)).toHaveLength(15);
  });
  it("trick room: flags a fast team without answers", () => {
    const team = [
      mon({
        species: "whimsicott",
        ability: "prankster",
        nature: "Timid",
        moves: ["moonblast"],
        sp: { hp: 0, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 },
      }),
    ];
    expect(diagnose(team, pack, spec, { now: NOW }).findings.map((f) => f.explainKey)).toContain(
      "matchup.trickRoom.noAnswer",
    );
  });
  it("terrain conflicts are detected too", () => {
    const team = [
      mon({ species: "rillaboom", ability: "grassysurge", moves: ["fakeout"] }),
      mon({ species: "indeedeef", ability: "psychicsurge", moves: ["followme"] }),
    ];
    expect(diagnose(team, pack, spec, { now: NOW }).findings.map((f) => f.explainKey)).toContain(
      "field.conflict.terrain",
    );
  });
});

describe("threat rules (usage snapshot)", () => {
  const usage: UsageSnapshot = {
    regulationId: "M-C",
    date: "2026-11-20",
    format: "doubles",
    source: { title: "テスト用の架空の使用率" },
    sample: true,
    entries: [
      {
        species: "garchomp",
        usage: 0.4,
        sets: [
          {
            share: 1,
            ability: "roughskin",
            nature: "Jolly",
            item: "garchompite",
            mega: true,
            sp: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
            moves: ["earthquake", "dragonclaw", "rockslide", "protect"],
          },
        ],
      },
      {
        species: "kingambit",
        usage: 0.3,
        sets: [
          {
            share: 1,
            ability: "defiant",
            nature: "Adamant",
            item: "blackglasses",
            mega: false,
            sp: { hp: 32, atk: 32, def: 2, spa: 0, spd: 0, spe: 0 },
            moves: ["kowtowcleave", "suckerpunch", "ironhead", "protect"],
          },
        ],
      },
      {
        species: "fluttermane",
        usage: 0.9,
        sets: [
          {
            share: 1,
            ability: "protosynthesis",
            nature: "Timid",
            mega: false,
            sp: { hp: 0, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 },
            moves: ["moonblast"],
          },
        ],
      },
    ],
  };
  const r = diagnose(sampleTeam("user-team-1"), pack, spec, { now: NOW, usage });
  it("applies only with a snapshot, ignores illegal species, records the snapshot in meta", () => {
    expect(r.meta.usageSnapshot).toBe("M-C@2026-11-20");
    expect(r.ruleScores.find((x) => x.ruleId === "offense.threats")?.applied).toBe(true);
    expect(JSON.stringify(r.findings)).not.toContain("fluttermane");
  });
  it("defense: Mega Garchomp's Rock Slide OHKOs Charizard (half of a 2-member team)", () => {
    expect(r.findings.find((x) => x.explainKey === "defense.threat.ohkoMany")).toBeUndefined(); // only 1/6 in the full team
    const full = sampleTeam("user-team-1");
    const pair = diagnose([full[0]!, full[4]!], pack, spec, { now: NOW, usage });
    const f = pair.findings.find((x) => x.explainKey === "defense.threat.ohkoMany");
    expect(f?.params).toMatchObject({
      threat: "garchomp",
      victims: "charizard",
      count: 1,
      total: 2,
    });
    expect(f?.evidence.some((e) => e.kind === "data" && e.snapshot === "2026-11-20")).toBe(true);
  });
  it("every threat finding renders with the explain templates", () => {
    for (const f of r.findings) expect(() => explainFinding(f)).not.toThrow();
  });
  it("works with the real Smogon M-C snapshot", async () => {
    const { readUsageSnapshots } = await import("@ca/data/node");
    const real = readUsageSnapshots("M-C")[0]!;
    const rr = diagnose(sampleTeam("user-team-1"), pack, spec, { now: NOW, usage: real });
    expect(rr.ruleScores.find((x) => x.ruleId === "defense.threats")?.applied).toBe(true);
    for (const f of rr.findings) expect(explainFinding(f).body).not.toMatch(/\{|undefined/);
  }, 60_000);
  it("offense: evidence includes the 2HKO probability", () => {
    for (const f of r.findings.filter((x) => x.ruleId === "offense.threats")) {
      expect(f.evidence[0]!.values).toHaveProperty("p2");
    }
  });
});

describe("weights and params come from data", () => {
  it("missing params fail fast", () => {
    const p = withWeights((w) => delete w.params["support.protect"]);
    expect(() => diagnose(sampleTeam("user-team-1"), p, spec, { now: NOW })).toThrow(
      RuleParamError,
    );
  });
  it("missing severity thresholds fail", () => {
    const p = withWeights((w) => delete w.severity);
    expect(() => diagnose(sampleTeam("user-team-1"), p, spec, { now: NOW })).toThrow(/severity/);
  });
  it("zero weights → score 0; every built-in rule has a weight and params in M-C", () => {
    const p = withWeights((w) => (w.rules = {}));
    expect(diagnose(sampleTeam("user-team-1"), p, spec, { now: NOW }).score).toBe(0);
    for (const rule of RULES) {
      expect(pack.weights.rules[rule.id]).toBeGreaterThan(0);
      for (const k of rule.params) expect(pack.weights.params[rule.id]?.[k]).toBeTypeOf("number");
    }
  });
  it("property: every finding has evidence and a template, for random subsets of the sample teams", () => {
    const pool = [
      ...sampleTeam("user-team-1"),
      ...sampleTeam("sample-trickroom"),
      ...sampleTeam("sample-rain"),
    ];
    fc.assert(
      fc.property(fc.subarray(pool, { minLength: 1, maxLength: 6 }), (team) => {
        const r = diagnose(team, pack, spec, { now: NOW });
        for (const f of r.findings) {
          expect(f.evidence.length).toBeGreaterThan(0);
          expect(() => explainFinding(f)).not.toThrow();
        }
      }),
      { numRuns: 25 },
    );
  });
});

describe("mechanics", () => {
  it("mega plugin is active in M-C and offers a mega action once", () => {
    expect(activeMechanics(pack).map((m) => m.id)).toEqual(["mega"]);
    const zard = sampleTeam("user-team-1")[0]!;
    const ctx = new RuleContext([zard], pack, spec);
    expect(
      megaMechanic.enumerateExtraActions(zard, {
        pack,
        used: false,
        canMega: (m) => ctx.canMega(m),
      }),
    ).toEqual(["mega"]);
    expect(
      megaMechanic.enumerateExtraActions(zard, {
        pack,
        used: true,
        canMega: (m) => ctx.canMega(m),
      }),
    ).toEqual([]);
  });
});
