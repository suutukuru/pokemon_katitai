import { describe, expect, it } from "vitest";
import { loadAllPacks, loadPack, PackValidationError, type PackIssue } from "../src/index.js";
import { FsPackSource } from "../src/node.js";
import { childOf, TestSource } from "./helpers.js";

function issuesOf(source: TestSource, id: string, opts = {}): PackIssue[] {
  try {
    loadPack(source, id, opts);
  } catch (e) {
    if (e instanceof PackValidationError) return [...e.issues];
    throw e;
  }
  throw new Error(`expected ${id} to be invalid`);
}

describe("real regulation packs", () => {
  const fs = new FsPackSource();

  it("every pack in packages/data/regulations validates", () => {
    const reports = loadAllPacks(fs, { knownMechanics: ["mega"] });
    expect(reports.map((r) => r.id)).toEqual(expect.arrayContaining(["M-C", "X-NEXT-DUMMY"]));
    for (const r of reports) expect(r.error?.message).toBeUndefined();
  });

  it("loads the current pack (M-C) as a root pack", () => {
    const p = loadPack(fs, "M-C");
    expect(p.chain).toEqual(["M-C"]);
    expect(p.rules).toMatchObject({ format: "doubles", level: 50, teamSize: 6, bringCount: 4 });
    expect(p.mechanics).toEqual(["mega"]);
    expect(p.legal.species).toContain("incineroar");
    expect(p.legal.megaSpecies).toContain("kangaskhan");
    expect(p.verified).toBe(false);
    expect(p.seasons).toEqual({ from: 6 });
    expect(p.periods.ranked?.start).toBe("2026-09-09");
  });

  it("loads the dummy next pack, inheriting and applying only its deltas", () => {
    const parent = loadPack(fs, "M-C");
    const p = loadPack(fs, "X-NEXT-DUMMY");
    expect(p.chain).toEqual(["M-C", "X-NEXT-DUMMY"]);
    expect(p.legal.species).toContain("fluttermane");
    expect(p.legal.species).not.toContain("kangaskhan");
    expect(p.legal.species).toContain("incineroar"); // inherited
    expect(p.legal.species.length).toBe(parent.legal.species.length + 3 - 1);
    expect(p.legal.megaSpecies).not.toContain("kangaskhan");
    expect(p.legal.items).not.toContain("kangaskhanite");
    expect(p.overrides.moves["fakeout"]?.basePower).toBe(30);
    // partial rules/weights merge
    expect(p.rules.bringCount).toBe(4);
    expect(p.rules.timers?.turnSeconds).toBe(45);
    expect(p.weights.search).toEqual({ depth: 3, beamWidth: 8, opponentTopK: 4 });
    expect(p.contentHash).not.toBe(parent.contentHash);
  });

  it("is deterministic (same content → same hash)", () => {
    expect(loadPack(fs, "X-NEXT-DUMMY")).toEqual(loadPack(new TestSource(), "X-NEXT-DUMMY"));
  });
});

describe("inheritance errors", () => {
  it("reports a missing parent", () => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("NOPE", "Z-1");
    expect(issuesOf(s, "Z-1")).toEqual([
      expect.objectContaining({
        packId: "Z-1",
        file: "manifest",
        path: "extends",
        message: expect.stringContaining('"NOPE" does not exist'),
      }),
    ]);
  });

  it("reports a missing pack", () => {
    expect(issuesOf(new TestSource(), "Q-9")[0]?.message).toContain('"Q-9" does not exist');
  });

  it("detects circular inheritance", () => {
    const s = new TestSource();
    s.packs["A-1"] = childOf("B-1", "A-1");
    s.packs["B-1"] = childOf("A-1", "B-1");
    const [issue] = issuesOf(s, "A-1");
    expect(issue?.message).toMatch(/circular inheritance: A-1 → B-1 → A-1/);
  });

  it("rejects manifest id / directory mismatch", () => {
    const s = new TestSource().edit("M-C", "manifest", (m) => (m["id"] = "M-Z"));
    expect(issuesOf(s, "M-C")).toContainEqual(expect.objectContaining({ path: "id" }));
  });

  it("supports multi-level chains", () => {
    const s = new TestSource();
    s.packs["Z-2"] = childOf("X-NEXT-DUMMY", "Z-2", {
      legal: { species: { add: [], remove: ["fluttermane"] } },
    });
    const p = loadPack(s, "Z-2");
    expect(p.chain).toEqual(["M-C", "X-NEXT-DUMMY", "Z-2"]);
    expect(p.legal.species).not.toContain("fluttermane");
    expect(p.overrides.moves["fakeout"]).toBeDefined();
  });

  it("null in overrides removes the parent's override", () => {
    const s = new TestSource();
    s.packs["Z-3"] = childOf("X-NEXT-DUMMY", "Z-3", { overrides: { moves: { fakeout: null } } });
    expect(loadPack(s, "Z-3").overrides.moves["fakeout"]).toBeUndefined();
  });

  it("deep-merges an override field by field", () => {
    const s = new TestSource();
    s.packs["Z-4"] = childOf("X-NEXT-DUMMY", "Z-4", {
      overrides: { moves: { fakeout: { accuracy: 90, verified: true } } },
    });
    expect(loadPack(s, "Z-4").overrides.moves["fakeout"]).toMatchObject({
      basePower: 30,
      accuracy: 90,
      verified: true,
    });
  });
});

describe("reference validation", () => {
  const child = (files: object) => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("M-C", "Z-1", files);
    return s;
  };

  it("rejects unknown species with the offending path", () => {
    const issues = issuesOf(
      child({ legal: { species: { add: ["incineroar", "Pikachuu"], remove: [] } } }),
      "Z-1",
    );
    expect(issues).toEqual([
      expect.objectContaining({
        packId: "Z-1",
        file: "legal",
        path: "species.add.1",
        message: 'unknown species "pikachuu"',
      }),
    ]);
  });

  it("rejects unknown items, banned moves and abilities", () => {
    const issues = issuesOf(
      child({
        legal: {
          items: { add: ["Sitrus Bery"] },
          bannedMoves: { add: ["Protectt"] },
          bannedAbilities: { add: ["Intimidat"] },
        },
      }),
      "Z-1",
    );
    expect(issues.map((i) => i.message)).toEqual([
      'unknown item "sitrusbery"',
      'unknown move "protectt"',
      'unknown ability "intimidat"',
    ]);
  });

  it("rejects overrides that target unknown entities", () => {
    const issues = issuesOf(
      child({
        overrides: {
          species: {
            notamon: { verified: false, baseStats: { spe: 1 } },
            incineroar: { verified: false, abilities: ["Nope"] },
          },
          moves: { notamove: { verified: false } },
          abilities: { notanability: { verified: false } },
          items: { notanitem: { verified: false } },
        },
      }),
      "Z-1",
    );
    expect(issues.map((i) => i.path).sort()).toEqual(
      [
        "abilities.notanability",
        "items.notanitem",
        "moves.notamove",
        "species.incineroar.abilities.0",
        "species.notamon",
      ].sort(),
    );
  });

  it("rejects removing something that the parent does not have", () => {
    const issues = issuesOf(child({ legal: { species: { remove: ["fluttermane"] } } }), "Z-1");
    expect(issues[0]).toMatchObject({
      path: "species.remove.0",
      message: expect.stringContaining("not present in the parent"),
    });
  });

  it("rejects `remove` in a root pack", () => {
    const s = new TestSource().edit(
      "M-C",
      "legal",
      (l) => ((l["items"] as { remove: string[] }).remove = ["lifeorb"]),
    );
    expect(issuesOf(s, "M-C")[0]?.message).toContain("root pack cannot remove");
  });

  it("requires a legal Mega Stone for every megaSpecies", () => {
    const issues = issuesOf(child({ legal: { items: { remove: ["gengarite"] } } }), "Z-1");
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "megaSpecies",
        message: '"gengar" has no legal Mega Stone in the items list',
      }),
    );
  });

  it("requires megaSpecies to be legal species", () => {
    const issues = issuesOf(child({ legal: { species: { remove: ["gengar"] } } }), "Z-1");
    expect(issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          '"gengar" can Mega Evolve but is not in the legal species',
        ),
      }),
    );
  });

  it("rejects Mega formes listed directly as species", () => {
    const issues = issuesOf(child({ legal: { species: { add: ["Gengar-Mega"] } } }), "Z-1");
    expect(issues[0]?.message).toContain("is a Mega forme");
  });

  it("requires the mega mechanic when megaSpecies exist", () => {
    const issues = issuesOf(
      child({}).edit("Z-1", "manifest", (m) => (m["mechanics"] = { remove: ["mega"] })),
      "Z-1",
    );
    expect(issues).toContainEqual(expect.objectContaining({ file: "manifest", path: "mechanics" }));
  });

  it("rejects unknown mechanic plugins when the registry is given", () => {
    const s = child({}).edit("Z-1", "manifest", (m) => (m["mechanics"] = { add: ["dynamax"] }));
    expect(loadPack(s, "Z-1").mechanics).toEqual(["dynamax", "mega"]);
    expect(issuesOf(s, "Z-1", { knownMechanics: ["mega"] })[0]?.message).toBe(
      'unknown mechanic plugin "dynamax"',
    );
  });

  it("lets newSpecies be referenced from the same pack and rejects duplicates of existing species", () => {
    const ns = {
      name: "Testmon",
      baseStats: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
      types: ["Normal"],
      abilities: ["Intimidate"],
      weightkg: 1,
      verified: false,
    };
    const ok = child({
      overrides: { newSpecies: { testmon: ns } },
      legal: { species: { add: ["Testmon"] } },
    });
    expect(loadPack(ok, "Z-1").legal.species).toContain("testmon");
    const dup = child({ overrides: { newSpecies: { incineroar: { ...ns, name: "Incineroar" } } } });
    expect(issuesOf(dup, "Z-1")[0]?.message).toContain("already exists in the base dex");
    const badRef = child({
      overrides: { newSpecies: { testmon: { ...ns, baseSpecies: "nope", abilities: ["nope"] } } },
    });
    expect(issuesOf(badRef, "Z-1").map((i) => i.path)).toEqual([
      "newSpecies.testmon.baseSpecies",
      "newSpecies.testmon.abilities.0",
    ]);
  });
});

describe("schema validation", () => {
  it("reports zod errors with file and path", () => {
    const s = new TestSource().edit("M-C", "rules", (r) => (r["bringCount"] = "four"));
    expect(issuesOf(s, "M-C")).toContainEqual(
      expect.objectContaining({ packId: "M-C", file: "rules", path: "bringCount" }),
    );
  });

  it("rejects unknown keys (typos) in pack files", () => {
    const s = new TestSource().edit("M-C", "legal", (l) => (l["specie"] = { add: [] }));
    expect(issuesOf(s, "M-C")[0]).toMatchObject({
      file: "legal",
      message: expect.stringContaining("specie"),
    });
  });

  it("requires full rules and weights in a root pack", () => {
    const s = new TestSource();
    delete s.packs["M-C"]!.rules;
    delete s.packs["M-C"]!.weights;
    expect(new Set(issuesOf(s, "M-C").map((i) => i.file))).toEqual(new Set(["rules", "weights"]));
  });

  it("allows a child pack with only a manifest", () => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("M-C", "Z-1");
    const p = loadPack(s, "Z-1");
    expect(p.legal).toEqual({ ...loadPack(s, "M-C").legal });
  });

  it("checks rule consistency after merging", () => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("M-C", "Z-1", { rules: { bringCount: 7 } });
    expect(issuesOf(s, "Z-1")[0]?.path).toBe("bringCount");
    s.packs["Z-1"] = childOf("M-C", "Z-1", { rules: { bringCount: 3, teamSize: 2 } });
    expect(issuesOf(s, "Z-1").map((i) => i.path)).toEqual(["bringCount"]);
  });

  it("collects issues across files and reports a readable message", () => {
    const s = new TestSource()
      .edit("M-C", "rules", (r) => (r["level"] = 0))
      .edit("M-C", "weights", (w) => (w["origin"] = "guessed"));
    try {
      loadPack(s, "M-C");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PackValidationError);
      expect((e as PackValidationError).issues.length).toBe(2);
      expect((e as Error).message).toMatch(/\[M-C\/rules\] level/);
    }
  });

  it("reports unreadable files", () => {
    const s = new TestSource();
    s.read = (id, f) => {
      if (f === "legal") throw new Error("boom");
      return TestSource.prototype.read.call(s, id, f);
    };
    expect(issuesOf(s, "M-C")[0]).toMatchObject({ file: "legal", message: "cannot read: boom" });
  });

  it("loadAllPacks collects errors instead of throwing", () => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("NOPE", "Z-1");
    const r = loadAllPacks(s);
    expect(r.find((x) => x.id === "Z-1")?.error).toBeInstanceOf(PackValidationError);
    expect(r.find((x) => x.id === "M-C")?.pack).toBeDefined();
  });
});
