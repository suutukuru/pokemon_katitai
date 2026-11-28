import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineTags, gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import {
  actionOrder,
  chooseFor,
  estimateDamage,
  forcedSwitchOptions,
  markLogSent,
  Rng,
  switchChoice,
  switchMatchup,
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

describe("R-4: damage estimate with every modifier (Showdown's own calculation)", () => {
  it("is within ±10% of @ca/calc (@smogon/calc) across items, boosts, screens and weather", async () => {
    const { ChampionsCalc } = await import("@ca/calc");
    const { PokemonSetSchema } = await import("@ca/schema");
    const golden = (
      await import("../../calc/test/golden/ingame-stats.json", { with: { type: "json" } })
    ).default;
    const calc = new ChampionsCalc(ctx.pack, ctx.spec);
    const base = golden.members.map((m) => PokemonSetSchema.parse(m.set));
    const params = { ...ctx.params, damageModel: 1 };
    type Cond = {
      name: string;
      atkItem?: string;
      defItem?: string;
      boost?: number;
      screens?: boolean;
      weather?: "Rain" | "Sun";
    };
    const conds: Cond[] = [
      { name: "plain" },
      { name: "+1", boost: 1 },
      { name: "screens", screens: true },
      { name: "rain", weather: "Rain" },
      { name: "sun", weather: "Sun" },
      { name: "band", atkItem: "choiceband" },
      { name: "vest", defItem: "assaultvest" },
    ];
    let checked = 0;
    const bad: string[] = [];
    for (const c of conds)
      base.forEach((a0, i) =>
        base.forEach((d0, j) => {
          if (i === j) return;
          const a = { ...a0, ...(c.atkItem ? { item: c.atkItem } : {}) };
          const d = { ...d0, ...(c.defItem ? { item: c.defItem } : {}) };
          const team1 = [a, ...base.filter((_, k) => k !== i)].slice(0, 4);
          const team2 = [d, ...base.filter((_, k) => k !== j)].slice(0, 4);
          const b = startBattle(ctx, team1, team2, [0, 1, 2, 3], [0, 1, 2, 3], 1);
          const atk = b.sides[0].active[0]!;
          const def = b.sides[1].active[0]!;
          if (c.boost) Object.assign(atk.boosts, { atk: c.boost, spa: c.boost });
          // undo lead effects (Intimidate, Drought …) so both calculators see the same state
          if (!c.boost) Object.assign(atk.boosts, { atk: 0, spa: 0 });
          Object.assign(def.boosts, { def: 0, spd: 0 });
          const bb = b as unknown as {
            field: { clearWeather(): void; setWeather(w: string, src: unknown): void };
            sides: { addSideCondition(c: string, src: unknown): void }[];
          };
          bb.field.clearWeather();
          if (c.weather) bb.field.setWeather(c.weather === "Rain" ? "raindance" : "sunnyday", atk);
          if (c.screens) {
            bb.sides[1]!.addSideCondition("reflect", def);
            bb.sides[1]!.addSideCondition("lightscreen", def);
          }
          for (const m of a.moves) {
            const mv = b.dex.moves.get(m);
            if (mv.category === "Status" || Array.isArray(mv.multihit) || mv.id === "tripleaxel")
              continue;
            const spread = ["allAdjacentFoes", "allAdjacent"].includes(mv.target) ? 2 : 1;
            const acc = mv.accuracy === true ? 1 : mv.accuracy / 100;
            const ours = estimateDamage(b, atk, def, mv, tags, params, spread) / acc;
            const r = calc.damage(
              { set: a, ...(c.boost ? { boosts: { atk: c.boost, spa: c.boost } } : {}) },
              { set: d },
              m,
              {
                ...(c.weather ? { weather: c.weather } : {}),
                ...(c.screens ? { defenderSide: { reflect: true, lightScreen: true } } : {}),
              },
            );
            const mean = r.distribution.reduce((x, o) => x + o.damage * o.p, 0);
            if (mean <= 0 && ours <= 0) continue;
            checked++;
            const ratio = ours / Math.max(1, mean);
            if (Math.abs(ratio - 1) > 0.1)
              bad.push(
                `${c.name} ${a.species} ${m} → ${d.species}: ${ours.toFixed(1)} vs ${mean.toFixed(1)}`,
              );
          }
        }),
      );
    expect(checked).toBeGreaterThan(150);
    expect(bad).toEqual([]);
  }, 60_000);
});

describe("R-5: switching", () => {
  /** Play until some side has a forced switch with at least two choices. */
  function atForcedSwitch(seed: number) {
    for (let s = seed; s < seed + 40; s++) {
      const b = startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], s);
      const rng = new Rng(s);
      for (let g = 0; g < 200 && !b.ended; g++) {
        for (const side of b.sides) {
          const req = side.activeRequest;
          if (req?.forceSwitch && !side.isChoiceDone() && forcedSwitchOptions(side, req).length > 1)
            return { b, side, req };
        }
        markLogSent(b);
        for (const side of b.sides) {
          if (b.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
            continue;
          const c = chooseFor(b, side, tags, ctx.params, rng);
          if (!b.choose(side.id, c)) b.choose(side.id, "default");
        }
      }
    }
    throw new Error("no forced switch found");
  }

  it("forced switch: every legal answer is listed; model 1 sends in the best matchup", () => {
    const { b, side, req } = atForcedSwitch(1);
    const opts = forcedSwitchOptions(side, req);
    expect(new Set(opts).size).toBe(opts.length);
    for (const o of opts) expect(o.split(", ")).toHaveLength(req.forceSwitch!.length);
    const old = switchChoice(b, side, req, tags, { ...ctx.params, forcedSwitchModel: 0 });
    expect(old).toBe(opts[0]);
    const params = { ...ctx.params, forcedSwitchModel: 1 };
    const pick = switchChoice(b, side, req, tags, params);
    const value = (o: string) =>
      [...o.matchAll(/switch (\d+)/g)].reduce(
        (a, m) => a + switchMatchup(b, side, side.pokemon[Number(m[1]) - 1]!, tags, params),
        0,
      );
    for (const o of opts) expect(value(pick)).toBeGreaterThanOrEqual(value(o) - 1e-9);
    expect(b.choose(side.id, pick)).toBe(true);
  });

  it("a threatened Pokémon switches more to a teammate that resists the biggest threat", () => {
    const b = fresh();
    const side = b.sides[0];
    const zero = { ...ctx.params, switchResistBonus: 0 };
    const on2 = { ...ctx.params, switchResistBonus: 0.5, switchResistRatio: 0.9 };
    const sw = (prm: Record<string, number>) =>
      slotMass(policyDistribution(b, side, tags, prm, T), 0, (_c, kind) => kind === "switch");
    expect(sw(on2)).toBeGreaterThan(sw(zero));
  });
});
