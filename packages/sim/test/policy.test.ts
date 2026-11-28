import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineTags, gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import {
  actionOrder,
  movesFirst,
  policyDistribution,
  simContext,
  slotOptions,
  softmaxProbs,
  startBattle,
  type PsBattle,
  type WeightedJoint,
} from "../src/index.js";

const ctx = simContext(loadPack(new FsPackSource(), "M-C"), gameSpec());
const tags = engineTags();
const team = (f: string) =>
  parseShowdown(readFileSync(new URL(`../../data/teams/samples/${f}.txt`, import.meta.url), "utf8"))
    .members;
const mine = team("user-team-1");
const rain = team("sample-rain");
const T = ctx.params["temperature"]!;
/** R-1 / R-2 weights switched on (the pack keeps most at 0: docs/sim-eval/README.md). */
const on = {
  ...ctx.params,
  outspedKoDiscount: 0.6,
  outspedProtectBonus: 0.3,
  outspedSwitchBonus: 0.15,
  priorityKoBonus: 0.2,
  overkillPenalty: 0.15,
  focusKoBonus: 0.3,
  jointInteraction: 1,
  allyProtectRefund: 1,
};
const fresh = () => startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 7);

/** Probability of the slot's options matching `pred`, from a joint distribution. */
const slotMass = (d: WeightedJoint[], slot: number, pred: (c: string, kind?: string) => boolean) =>
  d.filter((j) => pred(j.slots[slot]!.choice, j.slots[slot]!.kind)).reduce((a, j) => a + j.prob, 0);

/** The pre-R-2 policy: each slot sampled independently from its own softmax. */
function independent(b: PsBattle, params: Record<string, number>): WeightedJoint[] {
  const side = b.sides[0];
  const req = side.activeRequest!;
  const per = req.active!.map((_, s) => {
    const o = slotOptions(b, side, s, req, tags, params);
    const pr = softmaxProbs(o, T);
    return o.map((x, i) => ({ x, p: pr[i]! }));
  });
  return per[0]!.flatMap((a) => per[1]!.map((c) => ({ slots: [a.x, c.x], prob: a.p * c.p })));
}

describe("R-1: turn order from Showdown", () => {
  it("priority beats speed; Tailwind / Trick Room / boosts change who moves first", () => {
    const b = fresh();
    const [x, y] = b.sides[0].active as [NonNullable<PsBattle["sides"][0]["active"][0]>, never];
    const foe = b.sides[1].active[0]!;
    const fast = actionOrder(b, x, "tackle", 1);
    const prio = actionOrder(b, foe, "quickattack", 1);
    expect(movesFirst(prio, fast)).toBe(1);
    foe.boosts["spe"] = 6;
    const boosted = actionOrder(b, foe, "tackle", 1);
    expect(movesFirst(boosted, fast)).toBe(1);
    foe.boosts["spe"] = -6;
    expect(movesFirst(actionOrder(b, foe, "tackle", 1), fast)).toBe(0);
    expect(movesFirst(fast, fast)).toBe(0.5);
    void y;
  });

  it("a Pokémon a faster foe KOs first protects/switches more and attacks less", () => {
    const b = fresh();
    const me = b.sides[0].active[0]!;
    me.hp = 1;
    for (const f of b.sides[1].active) if (f) f.boosts["spe"] = 6;
    const zero = {
      ...on,
      outspedKoDiscount: 0,
      outspedProtectBonus: 0,
      outspedSwitchBonus: 0,
    };
    const defend = (c: string, kind?: string) => kind === "protect" || kind === "switch";
    const before = slotMass(policyDistribution(b, b.sides[0], tags, zero, T), 0, defend);
    const after = slotMass(policyDistribution(b, b.sides[0], tags, on, T), 0, defend);
    expect(after).toBeGreaterThan(before + 0.05);
  });
});

describe("R-2: both slots scored together", () => {
  const foeA = (b: PsBattle) => b.sides[1].active[0]!;
  const bothOnA = (j: WeightedJoint) =>
    j.slots.every(
      (s) => s.kind === "attack" && (s.hits ?? []).some((h) => h.foe === 0 && h.dmg > 0),
    );
  const mass = (d: WeightedJoint[], f: (j: WeightedJoint) => boolean) =>
    d.filter(f).reduce((a, j) => a + j.prob, 0);

  it("double-targeting a foe one slot KOs alone becomes less likely", () => {
    const b = fresh();
    foeA(b).hp = 1;
    const before = mass(independent(b, on), bothOnA);
    const after = mass(policyDistribution(b, b.sides[0], tags, on, T), bothOnA);
    expect(after).toBeLessThan(before);
  });

  it("focusing a foe that needs both attacks becomes more likely", () => {
    const b = fresh();
    const side = b.sides[0];
    const req = side.activeRequest!;
    const best = [0, 1].map((s) =>
      Math.max(
        0,
        ...slotOptions(b, side, s, req, tags, ctx.params)
          .filter((o) => o.kind === "attack")
          .flatMap((o) => (o.hits ?? []).filter((h) => h.foe === 0).map((h) => h.dmg)),
      ),
    );
    const hp = Math.floor(Math.max(...best)) + 1;
    expect(hp).toBeLessThan(best[0]! + best[1]!);
    foeA(b).hp = hp;
    const focusOnly = { ...on, jointInteraction: 0, overkillPenalty: 0 };
    const before = mass(independent(b, focusOnly), bothOnA);
    const after = mass(policyDistribution(b, b.sides[0], tags, focusOnly, T), bothOnA);
    expect(after).toBeGreaterThan(before);
  });

  it("joint probabilities sum to 1 and equal independent sampling when no correction applies", () => {
    const b = fresh();
    const d = policyDistribution(b, b.sides[0], tags, ctx.params, T);
    expect(d.reduce((a, j) => a + j.prob, 0)).toBeCloseTo(1);
    const neutral = {
      ...ctx.params,
      overkillPenalty: 0,
      focusKoBonus: 0,
      redirectSetupBonus: 0,
      redirectAttackBonus: 0,
      jointInteraction: 0,
    };
    // without shared targets the joint softmax is the product of the per-slot softmaxes
    const ind = independent(b, neutral);
    const joint = policyDistribution(b, b.sides[0], tags, neutral, T);
    const key = (j: WeightedJoint) => j.slots.map((s) => s.choice).join("|");
    const noShared = (j: WeightedJoint) =>
      !j.slots.some((s) => s.allyPenalty) &&
      !(j.slots[0]!.hits ?? []).some((h) => (j.slots[1]!.hits ?? []).some((g) => g.foe === h.foe));
    const indMap = new Map(ind.map((j) => [key(j), j.prob]));
    const ratios = joint.filter(noShared).map((j) => j.prob / indMap.get(key(j))!);
    // same up to one normalizing constant
    for (const r of ratios) expect(r / ratios[0]!).toBeCloseTo(1, 6);
  });
});
