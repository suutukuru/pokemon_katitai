import { describe, expect, it } from "vitest";
import { regDiff, regNew, regValidate, type Io } from "../src/index.js";
import { childOf, TestSource } from "../../data/test/helpers.js";

function io(): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (l) => outLines.push(l), err: (l) => errLines.push(l) };
}

describe("reg:new", () => {
  it("scaffolds a child pack that validates", () => {
    const s = new TestSource();
    const o = io();
    expect(regNew(["M-D", "--extends", "M-C", "--name-ja", "シーズンC"], s, o, "2026-12-01")).toBe(
      0,
    );
    expect(s.packs["M-D"]?.manifest).toMatchObject({
      id: "M-D",
      extends: "M-C",
      dataVersion: "2026-12-01.1",
      name: { ja: "シーズンC" },
    });
    expect(regValidate(["M-D"], s, io())).toBe(0);
  });
  it("accepts --flag=value and refuses existing ids, bad parents and missing args", () => {
    const s = new TestSource();
    expect(regNew(["M-D", "--extends=X-NEXT-DUMMY"], s, io(), "2026-12-01")).toBe(0);
    expect(regNew(["M-C"], s, io(), "2026-12-01")).toBe(1);
    expect(() => regNew(["M-E", "--extends", "NOPE"], s, io(), "2026-12-01")).toThrow(
      /does not exist/,
    );
    expect(regNew([], s, io(), "2026-12-01")).toBe(2);
    expect(() => regNew(["M-F", "--extends"], s, io(), "2026-12-01")).toThrow(/requires a value/);
  });
});

describe("reg:diff", () => {
  it("prints text and json", () => {
    const s = new TestSource();
    const o = io();
    expect(regDiff(["M-C", "X-NEXT-DUMMY"], s, o)).toBe(0);
    expect(o.outLines[0]).toContain("差分: M-C → X-NEXT-DUMMY");
    const j = io();
    regDiff(["M-C", "X-NEXT-DUMMY", "--json"], s, j);
    expect(JSON.parse(j.outLines[0]!).legal.species.removed).toEqual(["kangaskhan"]);
    expect(regDiff(["M-C"], s, io())).toBe(2);
  });
});

describe("reg:validate", () => {
  it("returns 1 and prints issues for invalid packs", () => {
    const s = new TestSource();
    s.packs["Z-1"] = childOf("M-C", "Z-1", { legal: { species: { add: ["nope"] } } });
    const o = io();
    expect(regValidate([], s, o)).toBe(1);
    expect(o.errLines.join("\n")).toContain('unknown species "nope"');
    expect(o.outLines.some((l) => l.startsWith("✓ M-C"))).toBe(true);
    expect(regValidate(["NOPE"], s, io())).toBe(1);
    expect(regValidate(["M-C"], s, io())).toBe(0);
  });
});
