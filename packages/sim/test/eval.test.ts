import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BattleRecordSchema, type BattleRecordInput } from "@ca/schema";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown, parseShowdownReplayLog } from "@ca/ingest";
import {
  compareSummaries,
  evaluateActions,
  playOut,
  resolveRecord,
  selectionRanks,
  simContext,
  startBattle,
  summarize,
  type MatchupAnalysis,
} from "../src/index.js";

const spec = gameSpec();
const pack = loadPack(new FsPackSource(), "M-C");
const ctx = simContext(pack, spec);
const text = (f: string) =>
  readFileSync(new URL(`../../data/teams/samples/${f}.txt`, import.meta.url), "utf8");
const mine = parseShowdown(text("user-team-1")).members;
const rain = parseShowdown(text("sample-rain")).members;
const T = ctx.params["temperature"]!;

/** A battle played by the policy itself, as a Showdown log. */
function policyBattleLog(seed: number) {
  const b = startBattle(ctx, mine, rain, [0, 1, 2, 5], [0, 1, 2, 3], seed);
  const result = playOut(ctx, b, seed);
  return { log: b.log.join("\n"), result };
}

describe("Showdown replay log → record", () => {
  it("extracts brought Pokémon, per-turn state, actions and the winner", () => {
    const { log, result } = policyBattleLog(1);
    const r = parseShowdownReplayLog(log);
    expect(r.issues).toEqual([]);
    expect(r.brought[0].slice(0, 2)).toEqual([mine[0]!.species, mine[1]!.species]);
    expect(r.brought[1].slice(0, 2)).toEqual([rain[0]!.species, rain[1]!.species]);
    expect(r.winner).toBe(result.winner);
    expect(r.turns[0]!.turn).toBe(1);
    expect(r.turns[0]!.state![0].map((m) => m.hpPct)).toEqual([100, 100]);
    for (const t of r.turns) {
      expect(t.actions[0]).toHaveLength(t.state![0].length);
      expect(t.actions[1]).toHaveLength(t.state![1].length);
    }
    const kinds = new Set(
      r.turns.flatMap((t) => [...t.actions[0], ...t.actions[1]].map((a) => Object.keys(a)[0])),
    );
    expect(kinds.has("move")).toBe(true);
  });
});

describe("policy evaluation against records (sim:eval)", () => {
  it("replays a converted log to the end with every action matched, deterministically", () => {
    const { log } = policyBattleLog(1);
    const rec = BattleRecordSchema.parse({
      id: "self-play-1",
      regulationId: "M-C",
      source: "showdown-log",
      teams: [text("user-team-1"), text("sample-rain")],
      brought: [[], []].map(() => ["x", "y"]) as [string[], string[]],
      showdownLog: log,
    } satisfies BattleRecordInput);
    const { record, teams, issues } = resolveRecord(rec);
    expect(issues).toEqual([]);
    const e = evaluateActions(ctx, record, teams, T);
    expect(e.divergence).toBeUndefined();
    expect(e.turnsEvaluated).toBe(e.turnsTotal);
    expect(e.actions.unmatched).toBe(0);
    expect(e.actions.slot.n).toBeGreaterThan(4);
    expect(e.actions.joint.n).toBeGreaterThan(0);
    expect(e.actions.slot.top3).toBeLessThanOrEqual(e.actions.slot.n);
    expect(Number.isFinite(e.actions.slot.logProb)).toBe(true);
    expect(evaluateActions(ctx, record, teams, T)).toEqual(e);
    // other seeds also replay to the end without divergence or unmatched actions
    for (const seed of [2, 3, 4, 5, 6]) {
      const r2 = resolveRecord({ ...rec, turns: [], showdownLog: policyBattleLog(seed).log });
      const e2 = evaluateActions(ctx, r2.record, r2.teams, T, seed);
      expect([seed, e2.divergence, e2.actions.unmatched]).toEqual([seed, undefined, 0]);
      expect(e2.turnsEvaluated).toBe(e2.turnsTotal);
    }
    const s = summarize("M-C", T, [{ ...e, selection: [] }]);
    expect(s.rates.slot.n).toBe(e.actions.slot.n);
    const cats = Object.values(s.rates.byCategory).reduce((a, t) => a + (t.n ? 1 : 0), 0);
    expect(cats).toBeGreaterThan(0);
    expect(compareSummaries(s, s).every((d) => d.delta === 0)).toBe(true);
  }, 60_000);

  it("a hand-entered record: the policy's favourite gets rank 1 and an off-list action counts as unmatched", () => {
    const rec = BattleRecordSchema.parse({
      id: "manual",
      regulationId: "M-C",
      source: "manual",
      teams: [text("user-team-1"), text("sample-rain")],
      brought: [
        [mine[0]!.species, mine[1]!.species, mine[2]!.species, mine[5]!.species],
        [rain[0]!.species, rain[1]!.species, rain[2]!.species, rain[3]!.species],
      ],
      turns: [
        {
          turn: 1,
          actions: [
            [{ move: "protect" }, { move: "notarealmove" }],
            [{ unknown: true }, { unknown: true }],
          ],
        },
      ],
    } satisfies BattleRecordInput);
    const { record, teams } = resolveRecord(rec);
    const e = evaluateActions(ctx, record, teams, T);
    expect(e.actions.unknown).toBe(2);
    const hasProtect = mine[0]!.moves.includes("protect");
    expect(e.actions.unmatched).toBe(hasProtect ? 1 : 2);
    expect(e.actions.joint.n).toBe(0);
  });

  it("ranks the recorded bring/leads in the screening order", () => {
    const sp = (c: number[]) => c.map((i) => mine[i]!.species);
    const fake = {
      screening: {
        mine: [
          { config: [0, 1, 2, 3], species: sp([0, 1, 2, 3]) },
          { config: [0, 2, 1, 3], species: sp([0, 2, 1, 3]) },
          { config: [0, 1, 2, 4], species: sp([0, 1, 2, 4]) },
          { config: [2, 3, 0, 1], species: sp([2, 3, 0, 1]) },
        ],
        theirs: [],
      },
      matrix: { mine: [sp([0, 1, 2, 3]), sp([2, 3, 0, 1])], theirs: [] },
      equilibrium: { mine: [0.25, 0.75], theirs: [] },
    } as unknown as MatchupAnalysis;
    const rec = BattleRecordSchema.parse({
      id: "sel",
      regulationId: "M-C",
      source: "manual",
      teams: [mine, rain],
      brought: [sp([3, 2, 1, 0]), [rain[0]!.species, rain[1]!.species]],
      turns: [{ turn: 1, actions: [[], []] }],
    } satisfies BattleRecordInput);
    const [r] = selectionRanks(fake, rec, [mine, rain]);
    expect(r).toEqual({
      side: 0,
      fourRank: 1,
      fours: 2,
      configRank: 4,
      configs: 4,
      leadRank: 3,
      leads: 3,
      eqProb: 0.75,
    });
  });
});
