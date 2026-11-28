import type { EngineTags, PokemonSet, TeacherDataset, TeacherPosition } from "@ca/schema";
import { engineTags } from "@ca/data";
import { successiveHalving, type SearchOptions } from "./bestplay.js";
import {
  actionMetrics,
  addTo,
  categoryOf,
  r4,
  rankOf,
  tallyRates,
  type ActionMetrics,
  type EvalRates,
} from "./eval.js";
import {
  chooseFor,
  forcedSwitchOptions,
  policyDistribution,
  searchCandidates,
  switchChoice,
  type WeightedJoint,
} from "./policy.js";
import { snap } from "./replay.js";
import { mixSeed, Rng } from "./rng.js";
import { markLogSent, startBattle, type Config, type SimContext } from "./runner.js";
import type { PsBattle } from "./showdown.js";

/**
 * The search as a teacher: label positions from policy self-play with the rollout search's
 * choice, then measure how often the heuristic policy agrees and how much win rate (by the
 * teacher's own estimates) it gives up. Used when no real battle records exist (ADR-0011).
 */

const needsMove = (b: PsBattle, i: 0 | 1) => {
  const r = b.sides[i].activeRequest;
  return !!r && !r.wait && !r.forceSwitch && !!r.active && !b.sides[i].isChoiceDone();
};

/** Play one policy-vs-policy battle and label every turn (both sides) with the search. */
export function teacherBattle(
  ctx: SimContext,
  teams: [string, string],
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  configs: [Config, Config],
  seed: number,
  opts: SearchOptions,
  /** which decisions to label */
  kinds: readonly ("move" | "switch")[] = ["move"],
): TeacherPosition[] {
  const tags = engineTags();
  const battle = startBattle(ctx, a, b, configs[0], configs[1], seed);
  const history: TeacherPosition["history"] = [];
  const rng = new Rng(mixSeed(seed, 0x7eac));
  const choose = (s: 0 | 1, c: string) => {
    const id = s === 0 ? "p1" : "p2";
    if (battle.choose(id, c)) history.push([s, c]);
    else {
      battle.choose(id, "default");
      history.push([s, "default"]);
    }
  };
  const out: TeacherPosition[] = [];
  let guard = 0;
  while (!battle.ended && battle.turn <= ctx.maxTurns && guard++ < ctx.maxTurns * 4) {
    markLogSent(battle);
    // forced switches: every legal switch-in, evaluated by rollouts from this exact point
    if (kinds.includes("switch"))
      for (const s of [0, 1] as const) {
        const side = battle.sides[s];
        const req = side.activeRequest;
        if (!req?.forceSwitch || side.isChoiceDone() || battle.ended) continue;
        const choices = forcedSwitchOptions(side, req);
        if (choices.length < 2) continue;
        const cands = choices.map((choice) => ({ choice, slots: [], score: 0 }));
        const ev = successiveHalving(
          ctx,
          snap(battle),
          s,
          cands,
          [],
          { options: cands.length, stages: [opts.stages.at(-1)!].map((x) => ({ ...x, keep: 1 })) },
          mixSeed(seed, 0x5c, battle.turn, s, history.length),
        );
        const best = ev.reduce((x, y) => (y.winRate > x.winRate ? y : x), ev[0]!);
        out.push({
          id: `${teams[0]}-${teams[1]}-${seed}-t${battle.turn}-${s}-sw${history.length}`,
          teams,
          configs,
          seed,
          history: history.map((h) => [h[0], h[1]] as [0 | 1, string]),
          side: s,
          kind: "switch",
          turn: Math.max(1, battle.turn),
          best: best.choice,
          candidates: ev.map((e) => ({
            choice: e.choice,
            winRate: r4(e.winRate),
            games: e.games,
            stage: e.stage,
          })),
        });
      }
    if (kinds.includes("move") && needsMove(battle, 0) && needsMove(battle, 1)) {
      const state = snap(battle);
      for (const s of [0, 1] as const) {
        const side = battle.sides[s];
        const cands = searchCandidates(battle, side, tags, ctx.params, opts.options);
        const active = side.active.map((m) => (m && !m.fainted ? m.species.id : ""));
        const ev = successiveHalving(
          ctx,
          state,
          s,
          cands,
          active,
          opts,
          mixSeed(seed, 0x7e, battle.turn, s),
        );
        const finalists = ev.filter((x) => x.stage === opts.stages.length);
        const best = finalists.reduce((x, y) => (y.winRate > x.winRate ? y : x), finalists[0]!);
        out.push({
          id: `${teams[0]}-${teams[1]}-${seed}-t${battle.turn}-${s}`,
          teams,
          configs,
          seed,
          history: history.map((h) => [h[0], h[1]] as [0 | 1, string]),
          side: s,
          kind: "move",
          turn: battle.turn,
          best: best.choice,
          candidates: ev.map((e) => ({
            choice: e.choice,
            winRate: r4(e.winRate),
            games: e.games,
            stage: e.stage,
          })),
        });
      }
    }
    for (const [s, side] of battle.sides.entries()) {
      if (battle.ended || side.isChoiceDone() || !side.activeRequest || side.activeRequest.wait)
        continue;
      const c = chooseFor(battle, side, tags, ctx.params, rng);
      choose(s as 0 | 1, c || "default");
    }
  }
  return out;
}

/** Rebuild the exact position (both sides at a move request). */
export function replayPosition(
  ctx: SimContext,
  data: TeacherDataset,
  pos: TeacherPosition,
): PsBattle {
  const a = data.teams[pos.teams[0]]!;
  const b = data.teams[pos.teams[1]]!;
  const battle = startBattle(
    ctx,
    a,
    b,
    pos.configs[0] as Config,
    pos.configs[1] as Config,
    pos.seed,
  );
  for (const [s, c] of pos.history) {
    markLogSent(battle);
    battle.choose(s === 0 ? "p1" : "p2", c);
  }
  markLogSent(battle);
  return battle;
}

const norm = (c: string) =>
  c
    .split(", ")
    .map((x) => x.replace(/ mega$/, ""))
    .join(", ");
const jointKey = (j: WeightedJoint) => norm(j.slots.map((s) => s.choice).join(", "));

/** Category of one slot fragment ("move 2 1", "switch 3", "pass") at this request. */
function slotCategory(b: PsBattle, sideIdx: 0 | 1, slot: number, frag: string, tags: EngineTags) {
  const req = b.sides[sideIdx].activeRequest;
  const m = /^move (\d+)/.exec(frag);
  if (m) {
    const mv = req?.active?.[slot]?.moves[Number(m[1]) - 1];
    if (mv) return categoryOf({ move: mv.id }, tags, b);
  }
  if (frag.startsWith("switch")) return "switch" as const;
  return undefined;
}

export interface TeacherEval {
  positions: number;
  temperature: number;
  actions: ActionMetrics;
  rates: EvalRates;
  /** teacher win rate of its best candidate, averaged */
  meanBestRate: number;
  /** policy's expected teacher win rate (over the candidates the teacher evaluated), averaged */
  meanPolicyRate: number;
  /** meanBestRate − meanPolicyRate: win rate the policy gives up by the teacher's estimate */
  meanRegret: number;
  /** share of the policy's probability that fell on candidates the teacher evaluated */
  coverage: number;
  /** forced switches (the policy's choice is deterministic): agreement and teacher win rate */
  forcedSwitch: { n: number; top1: number; meanPolicyRate: number; meanBestRate: number };
}

/** Compare the current policy with the teacher's labels. Deterministic. */
export function evaluateAgainstTeacher(
  ctx: SimContext,
  data: TeacherDataset,
  temperature: number,
): TeacherEval {
  const tags = engineTags();
  const metrics = actionMetrics();
  let bestSum = 0;
  let polSum = 0;
  let covSum = 0;
  const sw = { n: 0, top1: 0, rateSum: 0, bestSum: 0 };
  for (const pos of data.positions) {
    if (pos.kind === "switch") {
      const battle = replayPosition(ctx, data, pos);
      const side = battle.sides[pos.side];
      const req = side.activeRequest;
      if (!req?.forceSwitch) throw new Error(`${pos.id}: not at a forced switch after replay`);
      const pick = switchChoice(battle, side, req, tags, ctx.params);
      const rate = new Map(pos.candidates.map((c) => [c.choice, c.winRate]));
      sw.n++;
      if (pick === pos.best) sw.top1++;
      sw.rateSum += rate.get(pick) ?? 0;
      sw.bestSum += rate.get(pos.best) ?? 0;
      continue;
    }
    const battle = replayPosition(ctx, data, pos);
    const side = battle.sides[pos.side];
    const dist = policyDistribution(battle, side, tags, ctx.params, temperature);
    if (dist.length === 0) throw new Error(`${pos.id}: not at a move request after replay`);
    const want = norm(pos.best);
    const wantSlots = want.split(", ");
    // joint
    const hit = dist.filter((j) => jointKey(j) === want);
    const pJoint = hit.reduce((x, j) => x + j.prob, 0);
    const jRank = rankOf(
      hit.length ? Math.max(...hit.map((j) => j.prob)) : 0,
      dist.filter((j) => jointKey(j) !== want).map((j) => j.prob),
    );
    addTo(metrics.joint, hit.length ? jRank : Infinity, pJoint);
    // slots
    wantSlots.forEach((frag, i) => {
      if (frag === "pass") return;
      const marg = new Map<string, number>();
      for (const j of dist) {
        const k = j.slots[i]!.choice.replace(/ mega$/, "");
        marg.set(k, (marg.get(k) ?? 0) + j.prob);
      }
      const p = marg.get(frag) ?? 0;
      const rank = marg.has(frag)
        ? rankOf(
            p,
            [...marg].filter(([k]) => k !== frag).map(([, v]) => v),
          )
        : Infinity;
      if (!marg.has(frag)) metrics.unmatched++;
      addTo(metrics.slot, rank, p);
      const cat = slotCategory(battle, pos.side, i, frag, tags);
      if (cat) addTo(metrics.byCategory[cat], rank, p);
    });
    // focus: two attacks into the same foe position
    const tgts = wantSlots.map((f, i) =>
      slotCategory(battle, pos.side, i, f, tags) === "attack"
        ? /^move \d+ (\d)/.exec(f)?.[1]
        : undefined,
    );
    if (tgts.length === 2 && tgts[0] && tgts[0] === tgts[1])
      addTo(metrics.byCategory.focus, hit.length ? jRank : Infinity, pJoint);
    // value by the teacher's estimates
    const rate = new Map(pos.candidates.map((c) => [norm(c.choice), c.winRate]));
    const best = rate.get(want) ?? 0;
    let mass = 0;
    let val = 0;
    for (const j of dist) {
      const r = rate.get(jointKey(j));
      if (r === undefined) continue;
      mass += j.prob;
      val += j.prob * r;
    }
    bestSum += best;
    polSum += mass > 0 ? val / mass : 0;
    covSum += mass;
  }
  const n = data.positions.length - sw.n;
  return {
    positions: n,
    forcedSwitch: {
      n: sw.n,
      top1: sw.n ? r4(sw.top1 / sw.n) : 0,
      meanPolicyRate: sw.n ? r4(sw.rateSum / sw.n) : 0,
      meanBestRate: sw.n ? r4(sw.bestSum / sw.n) : 0,
    },
    temperature,
    actions: metrics,
    rates: {
      slot: tallyRates(metrics.slot),
      joint: tallyRates(metrics.joint),
      byCategory: Object.fromEntries(
        Object.entries(metrics.byCategory).map(([k, t]) => [k, tallyRates(t)]),
      ),
    },
    meanBestRate: n ? r4(bestSum / n) : 0,
    meanPolicyRate: n ? r4(polSum / n) : 0,
    meanRegret: n ? r4((bestSum - polSum) / n) : 0,
    coverage: n ? r4(covSum / n) : 0,
  };
}

/** Before/after rows for teacher evaluations (after − before). */
export function compareTeacherEvals(
  before: TeacherEval,
  after: TeacherEval,
): { metric: string; before: number; after: number; delta: number }[] {
  const rows: { metric: string; before: number; after: number; delta: number }[] = [];
  const push = (metric: string, b?: number, a?: number) => {
    if (b !== undefined && a !== undefined)
      rows.push({ metric, before: b, after: a, delta: r4(a - b) });
  };
  for (const k of ["slot", "joint"] as const)
    for (const m of ["top1", "top3", "meanLogProb"] as const)
      push(`${k}.${m}`, before.rates[k][m], after.rates[k][m]);
  for (const c of Object.keys(after.rates.byCategory))
    push(`category.${c}.top1`, before.rates.byCategory[c]?.top1, after.rates.byCategory[c]?.top1);
  push("meanPolicyRate", before.meanPolicyRate, after.meanPolicyRate);
  push("meanRegret", before.meanRegret, after.meanRegret);
  push("coverage", before.coverage, after.coverage);
  if (before.forcedSwitch?.n && after.forcedSwitch?.n) {
    push("forcedSwitch.top1", before.forcedSwitch.top1, after.forcedSwitch.top1);
    push(
      "forcedSwitch.meanPolicyRate",
      before.forcedSwitch.meanPolicyRate,
      after.forcedSwitch.meanPolicyRate,
    );
  }
  return rows;
}
