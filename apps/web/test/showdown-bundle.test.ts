// The browser bundle of pokemon-showdown (scripts/build-showdown.mjs) must play exactly the same
// battles as the Node package: same protocol log for the same teams, seeds and choices.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import {
  simContext,
  startBattle,
  playOut,
  toShowdownSet,
  chooseFor,
  Rng,
  type Battle,
} from "@ca/sim";
import { engineTags } from "@ca/data";

const bundle = fileURLToPath(new URL("../src/gen/showdown.js", import.meta.url));
const pack = loadPack(new FsPackSource(), "M-C");
const ctx = simContext(pack, gameSpec());
const team = (f: string) =>
  parseShowdown(
    readFileSync(new URL(`../../../packages/data/teams/samples/${f}.txt`, import.meta.url), "utf8"),
  ).members;

describe("Showdown browser bundle", () => {
  it("replays the Node engine's battles line by line", async () => {
    if (!existsSync(bundle))
      execFileSync("node", [
        fileURLToPath(new URL("../scripts/build-showdown.mjs", import.meta.url)),
      ]);
    const ps = (await import(bundle)).default as { Battle: typeof Battle };
    const a = team("user-team-1");
    const b = team("sample-rain");
    const tags = engineTags();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      // play with the Node engine, recording every choice
      const live = startBattle(ctx, a, b, [0, 1, 2, 5], [0, 1, 2, 3], seed);
      const inputs: [string, string][] = [];
      const rng = new Rng(seed);
      let guard = 0;
      while (!live.ended && guard++ < 200) {
        for (const side of live.sides) {
          if (live.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
            continue;
          const c = chooseFor(live, side, tags, ctx.params, rng) || "default";
          if (!live.choose(side.id, c)) live.choose(side.id, "default");
          inputs.push([side.id, c]);
        }
        (live as unknown as { sentLogPos: number }).sentLogPos = live.log.length;
      }
      // replay the same inputs on the bundle
      const sd = new ps.Battle({
        formatid: ctx.format,
        seed: [seed & 0xffff, (seed >>> 16) & 0xffff, 0x1234, 0x5678],
      });
      sd.setPlayer("p1", { name: "A", team: a.map((s) => toShowdownSet(s, 31, 50)) });
      sd.setPlayer("p2", { name: "B", team: b.map((s) => toShowdownSet(s, 31, 50)) });
      sd.choose("p1", "team 1236");
      sd.choose("p2", "team 1234");
      for (const [id, c] of inputs) {
        if (!sd.choose(id as "p1" | "p2", c)) sd.choose(id as "p1" | "p2", "default");
        (sd as unknown as { sentLogPos: number }).sentLogPos = sd.log.length;
      }
      const noClock = (log: string[]) => log.filter((l) => !l.startsWith("|t:|"));
      expect(noClock(sd.log)).toEqual(noClock(live.log));
      expect(live.ended).toBe(true);
    }
    // save/restore (used by every rollout) works in the bundle and continues identically
    const one = new ps.Battle({ formatid: ctx.format, seed: [7, 0, 0x1234, 0x5678] });
    one.setPlayer("p1", { name: "A", team: a.map((s) => toShowdownSet(s, 31, 50)) });
    one.setPlayer("p2", { name: "B", team: b.map((s) => toShowdownSet(s, 31, 50)) });
    one.choose("p1", "team 1236");
    one.choose("p2", "team 1234");
    const B = ps.Battle as unknown as { fromJSON(x: unknown): typeof one };
    const copy = B.fromJSON(
      JSON.parse(JSON.stringify((one as unknown as { toJSON(): unknown }).toJSON())),
    );
    for (const x of [one, copy]) {
      x.choose("p1", "default");
      x.choose("p2", "default");
    }
    expect(copy.log.filter((l) => !l.startsWith("|t:|"))).toEqual(
      one.log.filter((l) => !l.startsWith("|t:|")),
    );
    expect(copy.turn).toBe(one.turn);
    void playOut;
  }, 120_000);
});
