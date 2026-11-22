import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PokemonSetSchema, type ResolvedPack } from "@ca/schema";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import {
  allConfigs,
  analyzeMatchup,
  Battle,
  budgetFrom,
  dedupeMega,
  inProcessExecutor,
  maximin,
  mixSeed,
  Rng,
  simContext,
  simulate,
  simulateForced,
  solveZeroSum,
  toShowdownSet,
  turnOneOptions,
  wilson,
} from "../src/index.js";
import golden from "../../calc/test/golden/ingame-stats.json" with { type: "json" };

const spec = gameSpec();
const pack = loadPack(new FsPackSource(), "M-C");
const ctx = simContext(pack, spec);
const team = (f: string) =>
  parseShowdown(readFileSync(new URL(`../../data/teams/samples/${f}.txt`, import.meta.url), "utf8"))
    .members;
const mine = team("user-team-1");
const rain = team("sample-rain");

describe("Showdown's Champions mod agrees with the in-game stats", () => {
  it("all 36 golden values (SP, nature, Lv50) match the simulator's stored stats", () => {
    const b = new Battle({ formatid: ctx.format, seed: [1, 2, 3, 4] });
    const sets = golden.members.map((m) => PokemonSetSchema.parse(m.set));
    b.setPlayer("p1", { name: "A", team: sets.map((s) => toShowdownSet(s, 31, 50)) });
    b.sides[0].pokemon.forEach((p, i) => {
      const o = golden.members[i]!.observed;
      const st = (p as unknown as { storedStats: Record<string, number> }).storedStats;
      expect({ hp: p.maxhp, ...st }).toEqual(o);
    });
  });
});

describe("battles", () => {
  it("are deterministic per seed and differ across seeds", () => {
    const a = simulate(ctx, mine, rain, [0, 1, 2, 3], [0, 1, 2, 3], 42);
    expect(simulate(ctx, mine, rain, [0, 1, 2, 3], [0, 1, 2, 3], 42)).toEqual(a);
    const results = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((s) =>
        JSON.stringify(simulate(ctx, mine, rain, [0, 1, 2, 3], [0, 1, 2, 3], s)),
      ),
    );
    expect(results.size).toBeGreaterThan(1);
    expect(a.turns).toBeGreaterThan(0);
  }, 30_000);

  it("the policy never makes an illegal choice", () => {
    const proto = (
      Battle as unknown as { prototype: { choose: (s: string, c: string) => boolean } }
    ).prototype;
    const orig = proto.choose;
    let rejected = 0;
    proto.choose = function (s, c) {
      const ok = orig.call(this, s, c);
      if (!ok) rejected++;
      return ok;
    };
    try {
      for (let s = 0; s < 20; s++)
        simulate(ctx, mine, team("sample-trickroom"), [0, 1, 4, 5], [0, 1, 2, 3], s);
      for (let s = 0; s < 20; s++) simulate(ctx, rain, mine, [1, 2, 0, 3], [2, 3, 4, 5], s);
    } finally {
      proto.choose = orig;
    }
    expect(rejected).toBe(0);
  }, 60_000);

  it("turn-1 options are legal and forced choices are applied", () => {
    const [a, b] = turnOneOptions(ctx, mine, rain, [0, 1, 2, 3], [0, 1, 2, 3], 4);
    expect(a).toHaveLength(4);
    expect(a[0]!.choice).toMatch(/^move \d/);
    expect(a.filter((o) => (o.choice.match(/mega/g) ?? []).length > 1)).toEqual([]);
    const r = simulateForced(
      ctx,
      mine,
      rain,
      [0, 1, 2, 3],
      [0, 1, 2, 3],
      a[0]!.choice,
      b[0]!.choice,
      3,
    );
    expect([0, 1, null]).toContain(r.winner);
  }, 30_000);

  it("requires a configured simulator", () => {
    const p = structuredClone(pack) as ResolvedPack;
    delete p.rules.simulator;
    expect(() => simContext(p, spec)).toThrow(/simulator/);
  });
});

describe("configs and helpers", () => {
  it("enumerates C(6,4) × C(4,2) = 90 distinct brings", () => {
    const c = allConfigs(6);
    expect(c).toHaveLength(90);
    expect(new Set(c.map((x) => `${[x[0], x[1]].sort()}|${[x[2], x[3]].sort()}`)).size).toBe(90);
    expect(allConfigs(4)).toHaveLength(6);
  });
  it("only one Mega per turn", () => {
    expect(dedupeMega(["move 1 mega", "move 2 1 mega"])).toEqual(["move 1 mega", "move 2 1"]);
  });
  it("rng and seeds are deterministic", () => {
    const a = new Rng(5);
    const b = new Rng(5);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(mixSeed(1, 2)).not.toBe(mixSeed(2, 1));
    fc.assert(
      fc.property(fc.integer(), (s) => {
        const x = new Rng(s).next();
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
      }),
    );
  });
  it("budgets come from weights.json and scale", () => {
    const b = budgetFrom(pack.weights.simulation, 0.5);
    expect(b.screenBattles).toBe(Math.round(pack.weights.simulation["screenBattles"]! * 0.5));
    expect(() => budgetFrom({})).toThrow(/screenBattles/);
  });
});

describe("game theory", () => {
  it("rock-paper-scissors → uniform, value 0.5", () => {
    const s = solveZeroSum(
      [
        [0.5, 0, 1],
        [1, 0.5, 0],
        [0, 1, 0.5],
      ],
      20000,
    );
    for (const x of [...s.row, ...s.col]) expect(x).toBeCloseTo(1 / 3, 1);
    expect(s.value).toBeCloseTo(0.5, 2);
  });
  it("a dominant row is played purely", () => {
    const s = solveZeroSum(
      [
        [0.9, 0.8],
        [0.4, 0.3],
      ],
      2000,
    );
    expect(s.row[0]).toBeGreaterThan(0.99);
    expect(
      maximin([
        [0.9, 0.8],
        [0.4, 0.3],
      ]),
    ).toEqual({ row: 0, value: 0.8 });
    expect(solveZeroSum([], 10)).toEqual({ row: [], col: [], value: 0 });
  });
  it("wilson interval contains the point estimate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (n, p) => {
          const w = Math.round(n * p);
          const [lo, hi] = wilson(w, n);
          expect(lo).toBeLessThanOrEqual(w / n + 1e-9);
          expect(hi).toBeGreaterThanOrEqual(w / n - 1e-9);
        },
      ),
    );
    expect(wilson(0, 0)).toEqual([0, 1]);
  });
});

describe("analyzeMatchup (tiny budget)", () => {
  const budget = {
    screenBattles: 1,
    topConfigs: 2,
    matrixBattles: 2,
    turnOptions: 2,
    turnRollouts: 1,
    fictitiousIterations: 500,
    strongConfigs: 0,
    strongGames: 1,
    strongSearch: {
      width: 2,
      pruneRollouts: 1,
      keep: 2,
      matrixRollouts: 1,
      refineRollouts: 0,
      refineSupport: 0.2,
      iterations: 200,
    },
  };
  it("produces screening, a solved matrix and the turn-1 decision table, deterministically", async () => {
    const run = () =>
      analyzeMatchup(ctx, mine, rain, inProcessExecutor(ctx, mine, rain), budget, 7);
    const a = await run();
    expect(a.battles).toBe(90 + 90 + 2 * 2 * 2 + 2 * 2 * 1);
    expect(a.screening.mine).toHaveLength(90);
    expect(a.matrix.cells).toHaveLength(2);
    expect(a.equilibrium.mine.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(a.turnOne.myOptions).toHaveLength(2);
    expect(a.turnOne.bestReplies).toHaveLength(2);
    expect(a.turnOne.mine).toHaveLength(4);
    expect(await run()).toEqual(a);
    expect(a.strong).toBeUndefined();
  }, 120_000);

  it("strong stage: search-vs-search battles on the top configs decide the recommendation", async () => {
    const b = { ...budget, strongConfigs: 2, strongGames: 1 };
    const a = await analyzeMatchup(ctx, mine, rain, inProcessExecutor(ctx, mine, rain), b, 7);
    expect(a.strong).toBeDefined();
    expect(a.strong!.cells).toHaveLength(2);
    expect(a.strong!.games).toBe(4);
    expect(a.strong!.equilibrium.mine.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    // the turn-1 table is built for the strong stage's most likely pairing
    const mi = a.strong!.equilibrium.mine.indexOf(Math.max(...a.strong!.equilibrium.mine));
    expect(a.turnOne.mine).toEqual(a.strong!.mine[mi]);
  }, 300_000);
});

describe("battle tracing", () => {
  it("records decisions with probabilities, parses events, and matches the untraced result", async () => {
    const { traceBattle } = await import("../src/index.js");
    const log = traceBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 3);
    expect(log.result).toEqual(simulate(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 3));
    const t1 = log.turns.find((t) => t.turn === 1)!;
    expect(t1.decisions).toHaveLength(4);
    for (const d of t1.decisions) {
      expect(d.options.reduce((a, o) => a + o.prob, 0)).toBeCloseTo(1);
      expect(d.chosen).toBeGreaterThanOrEqual(0);
    }
    const kinds = new Set(log.turns.flatMap((t) => t.events.map((e) => e.t)));
    expect(kinds).toEqual(expect.objectContaining(new Set(["switch", "move", "damage", "faint"])));
    expect([...kinds]).toEqual(
      expect.arrayContaining(["switch", "move", "damage", "faint", "mega", "weather"]),
    );
    const last = log.turns.at(-1)!;
    expect(last.hp.filter((h) => h.side === 1).every((h) => h.hp === 0)).toBe(
      log.result.winner === 0,
    );
    for (const t of log.turns)
      for (const h of t.hp) {
        expect(h.hp).toBeGreaterThanOrEqual(0);
        expect(h.hp).toBeLessThanOrEqual(100);
      }
  }, 30_000);
});

describe("what-if replay analysis", () => {
  it("evaluates alternatives from saved states without changing the battle", async () => {
    const { analyzeReplay } = await import("../src/index.js");
    const r = analyzeReplay(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 3, {
      options: 3,
      rollouts: 2,
    });
    expect(r.result).toEqual(simulate(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 3));
    const analysed = r.turns.filter((t) => t.whatIf);
    expect(analysed.length).toBeGreaterThan(0);
    for (const t of analysed) {
      expect(t.whatIf!.filter((w) => w.chosen)).toHaveLength(1);
      for (const w of t.whatIf!) {
        expect(w.games).toBe(2);
        expect(w.slots.every((s) => s.species !== "")).toBe(true);
      }
    }
    expect(r.members.filter((m) => m.side === 0)).toHaveLength(4);
    expect(
      analyzeReplay(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 3, { options: 3, rollouts: 2 }),
    ).toEqual(r);
  }, 120_000);
});

describe("simultaneous-move search", () => {
  const tiny = {
    width: 3,
    pruneRollouts: 1,
    keep: 3,
    matrixRollouts: 2,
    refineRollouts: 2,
    refineSupport: 0.2,
    iterations: 500,
  };
  it("analyses a position: matrix, equilibrium and per-option values are consistent", async () => {
    const { analyzePosition, inProcessRollouts, snap, startBattle, bestChoice } =
      await import("../src/index.js");
    const state = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 7));
    const exec = inProcessRollouts(ctx);
    const a = await analyzePosition(ctx, state, exec, tiny, 11);
    expect(a.needs).toEqual([true, true]);
    expect(a.kind).toBe("move");
    for (const s of [0, 1] as const) {
      const inM = a.options[s].filter((o) => o.inMatrix);
      expect(inM.length).toBeLessThanOrEqual(tiny.keep);
      expect(inM.length).toBe(a.matrixChoices[s].length);
      expect(inM.reduce((x, o) => x + o.prob, 0)).toBeCloseTo(1, 6);
      for (const o of a.options[s]) {
        expect(o.value).toBeGreaterThanOrEqual(0);
        expect(o.value).toBeLessThanOrEqual(1);
        expect(o.worst).toBeLessThanOrEqual(o.value + 1e-9);
      }
      expect(a.options[s].some((o) => o.choice === bestChoice(a, s))).toBe(true);
    }
    // the matrix is the payoff for p1; the equilibrium value lies within its range
    const flat = a.matrix.flat();
    expect(a.value).toBeGreaterThanOrEqual(Math.min(...flat) - 1e-9);
    expect(a.value).toBeLessThanOrEqual(Math.max(...flat) + 1e-9);
    // deterministic, and the starting state is not modified
    expect(await analyzePosition(ctx, state, exec, tiny, 11)).toEqual(a);
    expect(a.rollouts).toBeGreaterThan(0);
  }, 120_000);

  it("a batched executor (split into chunks) gives the same rollouts as in-process", async () => {
    const { inProcessRollouts, rollout, rolloutContext, snap, startBattle } =
      await import("../src/index.js");
    const state = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 7));
    const items = [1, 2, 3, 4, 5].map((k) => ({ a: "", b: "", seed: k }));
    const whole = await inProcessRollouts(ctx).rollouts({ state, items });
    const rc = rolloutContext(ctx);
    const parts = [items.slice(0, 2), items.slice(2)].flatMap((xs) =>
      xs.map((it) => rollout(rc, state, it)),
    );
    expect(parts).toEqual(whole);
    for (const v of whole) expect([0, 0.5, 1]).toContain(v);
  }, 60_000);

  it("best-play battles use the search at every decision; deterministic", async () => {
    const { playBestBattle, searchBudgetFrom } = await import("../src/index.js");
    const r = await playBestBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 5, tiny);
    expect(r.mode).toBe("best");
    const turns = r.turns.filter((t) => t.whatIf);
    expect(turns.length).toBeGreaterThan(0);
    for (const t of turns) {
      expect(t.eval).toBeGreaterThanOrEqual(0);
      expect(t.eval).toBeLessThanOrEqual(1);
      for (const list of [t.whatIf!, t.whatIfOpp!]) {
        const chosen = list.filter((w) => w.chosen);
        expect(chosen).toHaveLength(1);
        const inM = list.filter((w) => w.inMatrix);
        expect(chosen[0]!.prob).toBe(Math.max(...inM.map((w) => w.prob ?? 0)));
      }
    }
    expect(await playBestBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 5, tiny)).toEqual(r);
    const b = searchBudgetFrom(pack.weights.simulation);
    expect(b.keep).toBeGreaterThan(1);
    expect(searchBudgetFrom(pack.weights.simulation, 2).matrixRollouts).toBe(2 * b.matrixRollouts);
    expect(() => searchBudgetFrom({})).toThrow(/search/);
  }, 300_000);
});

describe("battle view and stepping", () => {
  it("step applies choices, returns the turn's events and is reproducible", async () => {
    const { snap, startBattle, step, viewOf, slotChoices } = await import("../src/index.js");
    const state = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 9));
    const v = viewOf(state);
    expect(v.request).toEqual(["move", "move"]);
    expect(v.sides[0].active.map((m) => m?.species)).toEqual([mine[0]!.species, mine[1]!.species]);
    expect(v.sides[0].bench).toHaveLength(2);
    const sc = slotChoices(ctx, state, 0);
    expect(sc.slots).toHaveLength(2);
    const a = sc.slots.map((x) => x.options[0]!.choice).join(", ");
    const r1 = step(ctx, state, a, "");
    // the step stops at the next decision: turn 2, or forced switch-ins still within turn 1
    expect(r1.view.turn === 2 || r1.view.request.includes("switch")).toBe(true);
    expect(r1.events.some((e) => e.t === "move")).toBe(true);
    expect(step(ctx, state, a, "")).toEqual(r1);
    // a re-roll may change the outcome but keeps the same decisions legal
    const r2 = step(ctx, state, a, r1.choices[1], { reroll: 123 });
    expect(r2.choices).toEqual(r1.choices);
  }, 60_000);
});

describe("position keys", () => {
  it("a live battle and a restored-then-stepped copy reach the same key", async () => {
    const { snap, startBattle, step, battleView } = await import("../src/index.js");
    const live = startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 21);
    const s0 = snap(live);
    const r = step(ctx, s0, "move 1 1, move 1 1", "move 1 1, move 1 2");
    expect(live.choose("p1", r.choices[0])).toBe(true);
    expect(live.choose("p2", r.choices[1])).toBe(true);
    expect(battleView(live).key).toBe(r.view.key);
    expect(r.view.key).not.toBe(
      battleView(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 21)).key,
    );
  });
});
