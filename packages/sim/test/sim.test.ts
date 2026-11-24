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
      worlds: 1,
      opponentExtra: 0,
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
    // a required member is in every screened bring
    const req = await analyzeMatchup(
      ctx,
      mine,
      rain,
      inProcessExecutor(ctx, mine, rain),
      budget,
      7,
      undefined,
      {
        require: [5],
      },
    );
    expect(req.screening.mine.length).toBe(60);
    for (const s of req.screening.mine) expect(s.config).toContain(5);
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
    worlds: 2,
    opponentExtra: 0,
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

describe("hidden information (planner mode)", () => {
  const tiny = {
    width: 3,
    pruneRollouts: 1,
    keep: 3,
    matrixRollouts: 2,
    refineRollouts: 0,
    refineSupport: 0.2,
    iterations: 300,
    worlds: 3,
    opponentExtra: 1,
  };
  it("the planner decides the same when only the opponent's hidden set differs", async () => {
    const { analyzePosition, inProcessRollouts, snap, startBattle, priorFromUsage } =
      await import("../src/index.js");
    const { readUsageSnapshots } = await import("@ca/data/node");
    const prior = priorFromUsage(readUsageSnapshots("M-C")[0]!);
    // same species, different unrevealed moves / item / spread for the opponent
    const alt = rain.map((m, i) =>
      i === 1
        ? { ...m, moves: [...m.moves.slice(0, 3), "protect"], sp: { ...m.sp, hp: 0, spe: 0 } }
        : i === 2
          ? { ...m, item: m.item === "leftovers" ? "sitrusberry" : "leftovers" }
          : m,
    );
    const exec = inProcessRollouts(ctx);
    const strip = (a: Awaited<ReturnType<typeof analyzePosition>>) => ({ ...a, key: "" });
    const s1 = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 7));
    const s2 = snap(startBattle(ctx, mine, alt, [0, 1, 2, 5], [0, 1, 2, 3], 7));
    const a1 = await analyzePosition(ctx, s1, exec, tiny, 3, { viewer: 0, prior });
    const a2 = await analyzePosition(ctx, s2, exec, tiny, 3, { viewer: 0, prior });
    expect(a1.viewer).toBe(0);
    expect(a1.worlds).toBe(3);
    expect(strip(a2)).toEqual(strip(a1));
    // the opponent's options are intents, never its unrevealed concrete moves
    expect(a1.options[1].every((o) => o.choice.startsWith("i:"))).toBe(true);
    // the full-information search does see the difference
    const f1 = await analyzePosition(ctx, s1, exec, tiny, 3);
    const f2 = await analyzePosition(ctx, s2, exec, tiny, 3);
    expect(f1.viewer).toBeNull();
    expect(strip(f2)).not.toEqual(strip(f1));
  }, 180_000);

  it("possible worlds keep public facts and resample hidden ones", async () => {
    const { snap, startBattle, step, restore, observe, determinize, priorFromUsage, Rng } =
      await import("../src/index.js");
    const { readUsageSnapshots } = await import("@ca/data/node");
    const prior = priorFromUsage(readUsageSnapshots("M-C")[0]!);
    let s = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 11));
    s = step(ctx, s, "", "").state;
    const real = restore(s);
    const obs = observe(real, 0);
    expect(obs.preview).toHaveLength(6);
    const rng = new Rng(1);
    const worlds = [0, 1, 2, 3, 4, 5].map(() =>
      restore(determinize(ctx, s, real, obs, prior, rng)),
    );
    for (const w of worlds) {
      expect(w.turn).toBe(real.turn);
      real.sides[1].active.forEach((m, i) => {
        const x = w.sides[1].active[i];
        if (!m) return;
        expect(x?.species.id).toBe(m.species.id);
        expect(Math.round((x!.hp / x!.maxhp) * 100)).toBeCloseTo(
          Math.round((m.hp / m.maxhp) * 100),
          -1,
        );
        // moves seen in use stay
        for (const ms of (m as unknown as { moveSlots: { id: string; used?: boolean }[] })
          .moveSlots)
          if (ms.used)
            expect(
              (x as unknown as { moveSlots: { id: string }[] }).moveSlots.map((y) => y.id),
            ).toContain(ms.id);
      });
      // my own side is untouched
      expect(w.sides[0].pokemon.map((p) => p.hp)).toEqual(real.sides[0].pokemon.map((p) => p.hp));
      // unseen back-line Pokémon come from the opponent's team preview
      for (const p of w.sides[1].pokemon)
        expect(obs.preview).toContain(p.species.id.replace(/mega[xy]?$/, ""));
    }
    // hidden information varies between worlds
    const sig = (b: (typeof worlds)[number]) =>
      b.sides[1].pokemon
        .map(
          (p) =>
            `${p.species.id}:${p.item}:${(p as unknown as { storedStats: { spe: number } }).storedStats.spe}`,
        )
        .join();
    expect(new Set(worlds.map(sig)).size).toBeGreaterThan(1);
  }, 60_000);
});

describe("reflection and the improvement loop", () => {
  it("summaries: Brier score, regret, surprises and calibration buckets", async () => {
    const { summarizeReviews } = await import("../src/index.js");
    const base = { side: 0 as const, turn: 1, chosen: "x", predictedProb: 0.5 };
    const s = summarizeReviews([
      {
        ...base,
        expected: 0.9,
        outcome: 1,
        opponentActed: true,
        actualColumn: 0,
        regret: 0,
        vsActual: 0.9,
        bestVsActual: 0.9,
      },
      {
        ...base,
        expected: 0.1,
        outcome: 0,
        opponentActed: true,
        actualColumn: 1,
        regret: 0.2,
        vsActual: 0.1,
        bestVsActual: 0.3,
      },
      { ...base, expected: 0.5, outcome: 1, opponentActed: true, actualColumn: -1 },
      { ...base, expected: 0.5, outcome: 0, opponentActed: false, actualColumn: -1 },
    ]);
    expect(s.decisions).toBe(4);
    expect(s.brier).toBeCloseTo((0.01 + 0.01 + 0.25 + 0.25) / 4);
    expect(s.meanRegret).toBeCloseTo(0.1);
    expect(s.bestReplyRate).toBeCloseTo(0.5);
    expect(s.surpriseRate).toBeCloseTo(1 / 3);
    expect(s.calibration.reduce((a, c) => a + c.n, 0)).toBe(4);
  });

  it("calibration fit recovers an over-optimistic evaluator and leaves a calibrated one alone", async () => {
    const { fitCalibration, calibrated, Rng } = await import("../src/index.js");
    const rng = new Rng(9);
    const make = (bias: (p: number) => number) =>
      Array.from({ length: 4000 }, () => {
        const p = 0.05 + 0.9 * rng.next();
        return {
          side: 0 as const,
          turn: 1,
          chosen: "",
          expected: p,
          opponentActed: false,
          actualColumn: -1,
          predictedProb: 0,
          outcome: rng.next() < bias(p) ? 1 : 0,
        };
      });
    const fair = fitCalibration(make((p) => p));
    expect(fair.a).toBeCloseTo(1, 0);
    expect(Math.abs(fair.b)).toBeLessThan(0.15);
    // true win rate is lower than predicted
    const opt = fitCalibration(make((p) => p * 0.6));
    const params = { evalCalibA: opt.a, evalCalibB: opt.b };
    expect(calibrated(0.7, params)).toBeLessThan(0.55);
    expect(calibrated(0.7, {})).toBe(0.7);
  });

  it("tuning keeps a change only when it wins clearly in paired games", async () => {
    const { tunePolicy, pairedJobs, pairedScore } = await import("../src/index.js");
    // fake duels: the side with the larger koBonus wins; setupValue makes no difference
    const run = async (jobs: ReturnType<typeof pairedJobs>) =>
      jobs.map((j) =>
        j.params[0]["koBonus"]! > j.params[1]["koBonus"]!
          ? 1
          : j.params[0]["koBonus"]! < j.params[1]["koBonus"]!
            ? 0
            : j.seed & 1,
      );
    const teams = [mine, rain];
    const r = await tunePolicy(
      { koBonus: 1, setupValue: 1 },
      ["koBonus", "setupValue"],
      teams,
      run,
      { games: 40, step: 0.3, z: 2, seed: 1, bring: 4, validate: 40 },
    );
    expect(r.validation?.accepted).toBe(true);
    expect(r.params["koBonus"]).toBeCloseTo(1.3);
    expect(r.params["setupValue"]).toBe(1);
    expect(r.steps.find((s) => s.key === "koBonus")!.accepted).toBe(true);
    // a change that only looked good by chance is dropped by the held-out check
    let calls = 0;
    const lucky = async (jobs: ReturnType<typeof pairedJobs>) =>
      calls++ === 0
        ? jobs.map((_, i) => (i % 2 === 0 ? 1 : 0)) // challenger "wins" every pair
        : jobs.map((j) => (j.seed >>> 3) & 1); // later: no real difference
    const r2 = await tunePolicy({ koBonus: 1 }, ["koBonus"], teams, lucky, {
      games: 40,
      step: 0.3,
      z: 2,
      seed: 2,
      bring: 4,
      validate: 400,
    });
    expect(r2.steps[0]!.accepted).toBe(true);
    expect(r2.validation?.accepted).toBe(false);
    expect(r2.params["koBonus"]).toBe(1);
    // paired jobs swap sides with the same seed
    const jobs = pairedJobs(teams, { k: 1 }, { k: 0 }, 4, 1, 4);
    expect(jobs[0]!.seed).toBe(jobs[1]!.seed);
    expect(jobs[0]!.params[0]).toEqual(jobs[1]!.params[1]);
    expect(pairedScore([1, 0, 1, 0]).score).toBe(1);
  });

  it("a decision review compares the choice with the best reply to what actually happened", async () => {
    const {
      analyzePosition,
      inProcessRollouts,
      snap,
      startBattle,
      priorFromUsage,
      bestChoice,
      reviewDecision,
      restore,
      concreteFor,
    } = await import("../src/index.js");
    const { readUsageSnapshots } = await import("@ca/data/node");
    const prior = priorFromUsage(readUsageSnapshots("M-C")[0]!);
    const st = snap(startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], 7));
    const budget = {
      width: 3,
      pruneRollouts: 1,
      keep: 3,
      matrixRollouts: 2,
      refineRollouts: 0,
      refineSupport: 0.2,
      iterations: 300,
      worlds: 2,
      opponentExtra: 0,
    };
    const an = await analyzePosition(ctx, st, inProcessRollouts(ctx), budget, 5, {
      viewer: 0,
      prior,
    });
    const mineC = bestChoice(an, 0);
    const oppIntent = an.matrixChoices[1][0]!;
    const opp = concreteFor(ctx, restore(st), 1, oppIntent);
    const r = reviewDecision(ctx, st, an, 0, mineC, opp);
    expect(r.opponentActed).toBe(true);
    expect(r.actualColumn).toBeGreaterThanOrEqual(0);
    expect(r.bestVsActual!).toBeGreaterThanOrEqual(r.vsActual!);
    expect(r.regret).toBeCloseTo(r.bestVsActual! - r.vsActual!);
    expect(r.labels?.chosen?.length).toBeGreaterThan(0);
  }, 120_000);
});
