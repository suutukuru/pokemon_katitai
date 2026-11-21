import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applySetDelta,
  baseDex,
  canonicalJson,
  deepMerge,
  diffPacks,
  formatDiff,
  gameSpec,
  isEmptyDiff,
  loadPack,
  mergeRecord,
  scaffoldPack,
  sha256Hex,
} from "../src/index.js";
import { childOf, TestSource } from "./helpers.js";

const id = fc.stringMatching(/^[a-z0-9]{1,6}$/);

describe("applySetDelta", () => {
  it("property: result = (parent ∪ add) − remove, sorted and unique", () => {
    fc.assert(
      fc.property(fc.array(id), fc.array(id), fc.array(id), (parent, add, remove) => {
        const r = applySetDelta(parent, { add, remove });
        const expected = [...new Set([...parent, ...add])]
          .filter((x) => !remove.includes(x))
          .sort();
        expect(r).toEqual(expected);
      }),
    );
  });
  it("property: empty delta is identity (modulo order)", () => {
    fc.assert(
      fc.property(fc.uniqueArray(id), (p) => {
        expect(applySetDelta(p, { add: [], remove: [] })).toEqual([...p].sort());
      }),
    );
  });
});

describe("deepMerge / mergeRecord", () => {
  it("merges objects and replaces arrays/scalars", () => {
    expect(
      deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2, d: undefined }),
    ).toEqual({ a: { b: 1, c: [3] }, d: 1, e: 2 });
    expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
  it("mergeRecord deletes on null and merges otherwise", () => {
    expect(
      mergeRecord<Record<string, number>>(
        { x: { a: 1, b: 2 }, y: { a: 1 } },
        { x: { b: 3 }, y: null, z: { a: 9 } },
      ),
    ).toEqual({ x: { a: 1, b: 3 }, z: { a: 9 } });
  });
  it("property: merging into an empty object yields the patch", () => {
    fc.assert(
      fc.property(fc.dictionary(id, fc.integer()), (p) => {
        expect(deepMerge({}, p)).toEqual(p);
      }),
    );
  });
});

describe("canonicalJson / sha256", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: 2 } })).toBe(
      canonicalJson({ a: { c: 2, d: [1, { x: 2, y: 1 }] }, b: 1 }),
    );
  });
  it("matches known SHA-256 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("property: matches node:crypto for arbitrary unicode", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (s) => {
        expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
      }),
      { numRuns: 200 },
    );
  });
});

describe("diffPacks", () => {
  const s = new TestSource();
  const a = loadPack(s, "M-C");
  const b = loadPack(s, "X-NEXT-DUMMY");

  it("lists added/removed species, items and overrides", () => {
    const d = diffPacks(a, b);
    expect(d.legal.species).toEqual({
      added: ["fluttermane", "ironhands", "ogerponwellspring"],
      removed: ["kangaskhan"],
    });
    expect(d.legal.megaSpecies.removed).toEqual(["kangaskhan"]);
    expect(d.overrides.moves).toEqual({ added: ["fakeout"], removed: [], changed: [] });
    expect(d.rules).toEqual([{ path: "timers.turnSeconds", from: undefined, to: 45 }]);
    expect(d.weights.map((w) => w.path)).toEqual(["search.depth", "version"]);
    expect(isEmptyDiff(d)).toBe(false);
  });

  it("is antisymmetric and empty against itself", () => {
    const ab = diffPacks(a, b);
    const ba = diffPacks(b, a);
    expect(ba.legal.species).toEqual({
      added: ab.legal.species.removed,
      removed: ab.legal.species.added,
    });
    expect(isEmptyDiff(diffPacks(a, a))).toBe(true);
    expect(formatDiff(diffPacks(a, a))).toContain("差分なし");
  });

  it("detects changed overrides and formats them", () => {
    s.packs["Z-1"] = childOf("X-NEXT-DUMMY", "Z-1", {
      overrides: { moves: { fakeout: { basePower: 20, verified: false } } },
    });
    const d = diffPacks(b, loadPack(s, "Z-1"));
    expect(d.overrides.moves.changed).toEqual(["fakeout"]);
    const text = formatDiff(diffPacks(a, b));
    expect(text).toContain("+ 使用可能ポケモン: fluttermane, ironhands, ogerponwellspring");
    expect(text).toContain("- メガシンカ可能: kangaskhan");
    expect(text).toContain("~ ルール timers.turnSeconds");
  });
});

describe("scaffoldPack", () => {
  it("creates a loadable child pack whose content equals the parent", () => {
    const s = new TestSource();
    s.packs["M-D"] = scaffoldPack({ id: "M-D", extends: "M-C", today: "2026-11-21" });
    const p = loadPack(s, "M-D");
    expect(p.chain).toEqual(["M-C", "M-D"]);
    expect(isEmptyDiff(diffPacks(loadPack(s, "M-C"), p))).toBe(true);
  });
  it("creates a loadable root pack", () => {
    const s = new TestSource({});
    s.packs["R-1"] = scaffoldPack({ id: "R-1", today: "2026-11-21", nameJa: "ルート" });
    const p = loadPack(s, "R-1");
    expect(p.name.ja).toBe("ルート");
    expect(p.legal.species).toEqual([]);
  });
  it("rejects invalid ids", () => {
    expect(() => scaffoldPack({ id: "bad id", today: "2026-11-21" })).toThrow();
  });
});

describe("dex / game spec", () => {
  it("knows Champions megas and their stones from @smogon/calc", () => {
    const dex = baseDex();
    expect(dex.species("dragonitemega")).toMatchObject({ baseId: "dragonite", isMega: true });
    expect(
      dex
        .megaStones()
        .get("meowsticite")
        ?.map((e) => e.baseId),
    ).toEqual(["meowstic", "meowsticf"]);
    expect(dex.megaStones().get("dragoninite")?.[0]).toEqual({
      baseId: "dragonite",
      megaId: "dragonitemega",
    });
    expect(dex.hasMove("tailwind")).toBe(true);
  });
  it("loads SP constants from data, verified against in-game screenshots", () => {
    const g = gameSpec();
    expect(g.statPoints.total).toMatchObject({ value: 66, verified: true });
    expect(g.statPoints.perStat.value).toBe(32);
  });
});
