import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { engineTags, gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import { benchPolicies, koChance, plannedJoints, simContext, startBattle } from "../src/index.js";

const ctx = simContext(loadPack(new FsPackSource(), "M-C"), gameSpec());
const tags = engineTags();
const team = (f: string) =>
  parseShowdown(readFileSync(new URL(`../../data/teams/samples/${f}.txt`, import.meta.url), "utf8"))
    .members;
const mine = team("user-team-1");
const rain = team("sample-rain");
const tr = team("sample-trickroom");

describe("koChance", () => {
  it("is a probability, monotone in damage and in remaining HP", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 400, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.integer({ min: 1, max: 300 }),
        (d, extra, hp) => {
          const k = koChance(d, hp);
          expect(k).toBeGreaterThanOrEqual(0);
          expect(k).toBeLessThanOrEqual(1);
          expect(koChance(d + extra, hp)).toBeGreaterThanOrEqual(k);
          expect(koChance(d, hp + extra)).toBeLessThanOrEqual(k);
        },
      ),
    );
    expect(koChance(100, 50)).toBe(1);
    expect(koChance(50, 100)).toBe(0);
    expect(koChance(0, 1)).toBe(0);
  });
});

describe("joint planner (policy 2)", () => {
  it("every joint option is a legal Showdown choice and no two slots switch to one Pokémon", () => {
    type C = [number, number, number, number];
    const cases: [typeof mine, typeof mine, C, C][] = [
      [mine, rain, [0, 1, 2, 3], [0, 1, 2, 3]],
      [rain, tr, [3, 4, 0, 1], [0, 1, 2, 3]],
      [tr, mine, [0, 1, 4, 5], [2, 3, 0, 1]],
    ];
    for (const [ta, tb, ca, cb] of cases) {
      const fresh = () => startBattle(ctx, ta, tb, ca, cb, 1);
      const b = fresh();
      for (const side of [0, 1] as const)
        for (const j of plannedJoints(b, b.sides[side], tags, ctx.params))
          expect(fresh().choose(side === 0 ? "p1" : "p2", j.choice), j.choice).toBe(true);
      for (const j of plannedJoints(b, b.sides[0], tags, ctx.params)) {
        const sw = j.slots.filter((s) => s.choice.startsWith("switch")).map((s) => s.choice);
        expect(new Set(sw).size).toBe(sw.length);
        expect((j.choice.match(/mega/g) ?? []).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("does not plan Fake Out after the user's first turn on the field", () => {
    // rain team: Rillaboom (Fake Out) leads
    const b = startBattle(ctx, rain, mine, [3, 0, 1, 2], [0, 1, 2, 3], 4);
    const side = b.sides[0];
    const fakeOutFirst = plannedJoints(b, side, tags, ctx.params).slice(0, 5);
    expect(fakeOutFirst.some((j) => j.slots.some((s) => s.moveId === "fakeout"))).toBe(true);
    b.choose("p1", "default");
    b.choose("p2", "default");
    const rilla = side.active.find((m) => m?.species.id === "rillaboom");
    expect(rilla?.activeMoveActions).toBeGreaterThan(0);
    if (rilla && !rilla.fainted && rilla.activeMoveActions > 0 && side.activeRequest?.active) {
      const top = plannedJoints(b, side, tags, ctx.params)[0]!;
      expect(top.slots.some((s) => s.moveId === "fakeout")).toBe(false);
    }
  });

  it("is stronger than the legacy per-slot heuristic (teams swapped, same seeds)", () => {
    const r = benchPolicies(ctx, mine, rain, ctx.params, { ...ctx.params, policy: 1 }, 12, 3);
    expect(r.games).toBe(24);
    expect(r.rate).toBeGreaterThan(0.5);
  }, 60_000);
});
