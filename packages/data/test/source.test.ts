import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack, MemoryPackSource, scaffoldPack } from "../src/index.js";
import { FsPackSource } from "../src/node.js";
import { realPacks } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("FsPackSource", () => {
  it("writes, lists and reads packs; refuses to overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "ca-packs-"));
    dirs.push(root);
    const s = new FsPackSource(root);
    s.write("R-1", scaffoldPack({ id: "R-1", today: "2026-11-21" }));
    expect(s.listPackIds()).toEqual(["R-1"]);
    expect(s.read("R-1", "rules")).toMatchObject({ level: 50 });
    expect(loadPack(s, "R-1").id).toBe("R-1");
    expect(() => s.write("R-1", {})).toThrow(/already exists/);
    expect(new FsPackSource(join(root, "missing")).listPackIds()).toEqual([]);
  });
});

describe("MemoryPackSource", () => {
  it("serves bundled JSON (browser path)", () => {
    const s = new MemoryPackSource(realPacks());
    expect(s.listPackIds()).toContain("M-C");
    expect(s.read("M-C", "manifest")).toMatchObject({ id: "M-C" });
    expect(s.read("NOPE", "manifest")).toBeUndefined();
    expect(loadPack(s, "X-NEXT-DUMMY").chain).toEqual(["M-C", "X-NEXT-DUMMY"]);
  });
});
