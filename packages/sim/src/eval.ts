import { toID, type BattleRecord, type PokemonSet, type RecordSlotAction } from "@ca/schema";
import { engineTags } from "@ca/data";
import type { EngineTags } from "@ca/schema";
import { parseShowdown, parseShowdownReplayLog } from "@ca/ingest";
import type { MatchupAnalysis } from "./analyze.js";
import { policyDistribution, PROTECT, type SlotOption, type WeightedJoint } from "./policy.js";
import { restore, reseed, snap } from "./replay.js";
import { mixSeed } from "./rng.js";
import { markLogSent, startBattle, type Config, type SimContext } from "./runner.js";
import type { PsBattle, PsPokemon, PsSide } from "./showdown.js";

/**
 * R-0: how well the heuristic policy predicts real play. Each recorded decision is replayed in
 * Showdown (the observed HP / status / boosts are written into the simulated state at every turn
 * start, so dice differences do not accumulate) and the policy's probabilities are compared with
 * what the player actually did.
 */

export const ACTION_CATEGORIES = [
  "protect",
  "fakeout",
  "switch",
  "speedControl",
  "attack",
  "other",
] as const;
export type ActionCategory = (typeof ACTION_CATEGORIES)[number];

/** Probability floor for log-likelihood (an action the policy gives 0). */
const LOG_FLOOR = 1e-6;

export interface Tally {
  n: number;
  top1: number;
  top3: number;
  /** sum of ln(p(actual)) */
  logProb: number;
}
const tally = (): Tally => ({ n: 0, top1: 0, top3: 0, logProb: 0 });
function addTo(t: Tally, rank: number, prob: number) {
  t.n++;
  if (rank === 1) t.top1++;
  if (rank <= 3) t.top3++;
  t.logProb += Math.log(Math.max(LOG_FLOOR, prob));
}
function mergeTally(a: Tally, b: Tally) {
  a.n += b.n;
  a.top1 += b.top1;
  a.top3 += b.top3;
  a.logProb += b.logProb;
}

export interface ActionMetrics {
  /** per active slot */
  slot: Tally;
  /** per side and turn, both slots together (only when every slot's action is known) */
  joint: Tally;
  byCategory: Record<ActionCategory | "focus", Tally>;
  /** recorded actions that were not among the legal options in the reconstructed state */
  unmatched: number;
  /** slots whose action is not observable (flinch, sleep, fainted first …) */
  unknown: number;
}
const actionMetrics = (): ActionMetrics => ({
  slot: tally(),
  joint: tally(),
  byCategory: Object.fromEntries(
    [...ACTION_CATEGORIES, "focus"].map((c) => [c, tally()]),
  ) as ActionMetrics["byCategory"],
  unmatched: 0,
  unknown: 0,
});
export function mergeActionMetrics(a: ActionMetrics, b: ActionMetrics): void {
  mergeTally(a.slot, b.slot);
  mergeTally(a.joint, b.joint);
  for (const k of Object.keys(a.byCategory) as (keyof ActionMetrics["byCategory"])[])
    mergeTally(a.byCategory[k], b.byCategory[k]);
  a.unmatched += b.unmatched;
  a.unknown += b.unknown;
}

export interface SelectionRank {
  side: 0 | 1;
  /** rank (1 = best) of the brought 4 among all 4-sets, ordered by their best screening rate */
  fourRank: number;
  fours: number;
  /** rank of the exact bring + lead pair among all configs */
  configRank: number;
  configs: number;
  /** rank of the lead pair among the lead pairs of the brought 4 */
  leadRank: number;
  leads: number;
  /** equilibrium probability, if this config reached the top-K matrix */
  eqProb?: number;
}

export interface RecordEval {
  id: string;
  turnsEvaluated: number;
  turnsTotal: number;
  /** why evaluation stopped early, if it did */
  divergence?: string;
  actions: ActionMetrics;
  selection: SelectionRank[];
}

export interface EvalSummary {
  regulationId: string;
  temperature: number;
  records: number;
  actions: ActionMetrics;
  /** derived rates (rounded) for reading and diffing */
  rates: EvalRates;
  selection: {
    n: number;
    fourTop1: number;
    fourTop3: number;
    meanFourRank: number;
    configTop3: number;
    meanConfigRank: number;
    leadTop1: number;
    meanLeadRank: number;
  };
  perRecord: RecordEval[];
}

export interface TallyRates {
  n: number;
  top1: number;
  top3: number;
  meanLogProb: number;
}
export interface EvalRates {
  slot: TallyRates;
  joint: TallyRates;
  byCategory: Record<string, TallyRates>;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
export const tallyRates = (t: Tally): TallyRates => ({
  n: t.n,
  top1: t.n ? r4(t.top1 / t.n) : 0,
  top3: t.n ? r4(t.top3 / t.n) : 0,
  meanLogProb: t.n ? r4(t.logProb / t.n) : 0,
});

/** Resolve a record's teams (pasted text or parsed sets) and fill turns from a Showdown log. */
export function resolveRecord(
  record: BattleRecord,
  legal?: { species: string[]; items: string[] },
): { record: BattleRecord; teams: [PokemonSet[], PokemonSet[]]; issues: string[] } {
  const issues: string[] = [];
  const teams = record.teams.map((t, i) => {
    if (typeof t !== "string") return t;
    const r = parseShowdown(t, legal ? { legal } : undefined);
    for (const x of r.issues.filter((y) => y.severity === "error"))
      issues.push(`team ${i}: ${x.line ?? ""} ${x.message}`);
    return r.members;
  }) as [PokemonSet[], PokemonSet[]];
  let rec = record;
  if (record.turns.length === 0 && record.showdownLog) {
    const parsed = parseShowdownReplayLog(record.showdownLog);
    issues.push(...parsed.issues);
    rec = {
      ...record,
      turns: parsed.turns,
      winner: record.winner ?? parsed.winner,
      // The log's order (leads first) wins; the record may add back members that never appeared.
      brought: [0, 1].map((i) => {
        const fromLog = parsed.brought[i as 0 | 1].slice(0, 4);
        const given = record.brought[i as 0 | 1];
        const sameLeads = given[0] === fromLog[0] && given[1] === fromLog[1];
        return sameLeads && given.length > fromLog.length ? given : fromLog;
      }) as [string[], string[]],
    };
  }
  return { record: rec, teams, issues };
}

const setSpecies = (m: PsPokemon) =>
  toID((m as unknown as { set: { species: string } }).set.species);

/** Brought species → a Config (team indices). Missing back slots are filled with unused members. */
export function configOf(team: readonly PokemonSet[], brought: readonly string[]): Config {
  const idx = brought.map((s) => {
    const i = team.findIndex((m) => m.species === s);
    if (i < 0) throw new Error(`brought "${s}" is not in the team`);
    return i;
  });
  for (let i = 0; idx.length < 4 && i < team.length; i++) if (!idx.includes(i)) idx.push(i);
  return idx as Config;
}

export function categoryOf(a: RecordSlotAction, tags: EngineTags, b: PsBattle): ActionCategory {
  if ("switch" in a) return "switch";
  if (!("move" in a)) return "other";
  if (PROTECT.has(a.move)) return "protect";
  if (a.move === "fakeout") return "fakeout";
  if (tags.moves.speedControl[a.move]) return "speedControl";
  return b.dex.moves.get(a.move).category === "Status" ? "other" : "attack";
}

/** Current form (e.g. after Mega Evolution) → the team sheet's species, for every Pokémon. */
let formMap = new Map<string, string>();
const base = (id: string | undefined) => (id === undefined ? id : (formMap.get(id) ?? id));

function matches(o: SlotOption, a: RecordSlotAction): boolean {
  if ("switch" in a) return base(o.switchTo) === a.switch;
  if ("move" in a)
    return (
      o.moveId === a.move && (!a.target || !o.targetSpecies || base(o.targetSpecies) === a.target)
    );
  if ("pass" in a) return o.choice === "pass";
  return false;
}

/** 1-based rank of `value` among `all` (ties count in the actual action's favour). */
const rankOf = (value: number, all: number[]) => 1 + all.filter((x) => x > value + 1e-12).length;

function syncState(
  side: PsSide,
  state: NonNullable<BattleRecord["turns"][number]["state"]>[0],
): string | undefined {
  const act = side.active.filter((m): m is PsPokemon => !!m && !m.fainted);
  if (act.length !== state.length)
    return `${side.id}: ${act.length} active in simulation, ${state.length} in record`;
  for (const st of state) {
    const mon = act.find((m) => setSpecies(m) === st.species || m.species.id === st.species);
    if (!mon) return `${side.id}: ${st.species} is not active in simulation`;
    mon.hp = Math.max(1, Math.min(mon.maxhp, Math.round((mon.maxhp * st.hpPct) / 100)));
    if (st.status !== undefined) {
      const ps = mon as unknown as {
        setStatus(s: string, src: null, eff: null, ignore: boolean): boolean;
        cureStatus(): void;
      };
      if (!st.status && mon.status) ps.cureStatus();
      else if (st.status && mon.status !== st.status) {
        if (mon.status) ps.cureStatus();
        ps.setStatus(st.status, null, null, true);
      }
    }
    if (st.boosts)
      for (const k of Object.keys(mon.boosts)) mon.boosts[k] = st.boosts[k] ?? mon.boosts[k]!;
  }
  return undefined;
}

/** Pick the choice string to apply for a recorded slot action (best-matching option). */
function choiceFor(
  dist: WeightedJoint[],
  slot: number,
  a: RecordSlotAction,
  canMega: boolean,
): string | undefined {
  const marg = new Map<string, { o: SlotOption; p: number }>();
  for (const j of dist) {
    const o = j.slots[slot]!;
    const e = marg.get(o.choice) ?? { o, p: 0 };
    e.p += j.prob;
    marg.set(o.choice, e);
  }
  const ms = [...marg.values()].filter((e) => matches(e.o, a)).sort((x, y) => y.p - x.p);
  const best = ms[0];
  if (!best) return undefined;
  const base = best.o.choice.replace(/ mega$/, "");
  return "move" in a && a.mega && canMega ? `${base} mega` : base;
}

/** Evaluate one record's turn-by-turn actions. */
export function evaluateActions(
  ctx: SimContext,
  record: BattleRecord,
  teams: [PokemonSet[], PokemonSet[]],
  temperature: number,
  /** Showdown seed of the reconstruction (the dice need not match: HP is re-synced each turn) */
  seed = 1,
): Omit<RecordEval, "selection"> {
  const tags = engineTags();
  const metrics = actionMetrics();
  const ca = configOf(teams[0], record.brought[0]);
  const cb = configOf(teams[1], record.brought[1]);
  let battle = startBattle(ctx, teams[0], teams[1], ca, cb, seed);
  const retries = ctx.params["evalReplayRetries"] ?? 0;
  let evaluated = 0;
  let divergence: string | undefined;
  const replacements: [string[], string[]] = [[], []];

  const forcedSwitches = () => {
    for (let guard = 0; guard < 8 && !battle.ended; guard++) {
      let any = false;
      markLogSent(battle);
      for (const [s, side] of battle.sides.entries()) {
        const req = side.activeRequest;
        if (!req?.forceSwitch || side.isChoiceDone()) continue;
        any = true;
        const used = new Set<number>();
        const parts = req.forceSwitch.map((must) => {
          if (!must) return "pass";
          const want = replacements[s as 0 | 1].shift();
          let idx = req.side.pokemon.findIndex(
            (pk, i) =>
              !pk.active &&
              !used.has(i) &&
              !pk.condition.endsWith(" fnt") &&
              (want === undefined || setSpecies(side.pokemon[i]!) === want),
          );
          if (idx < 0)
            idx = req.side.pokemon.findIndex(
              (pk, i) => !pk.active && !used.has(i) && !pk.condition.endsWith(" fnt"),
            );
          if (idx < 0) return "pass";
          used.add(idx);
          return `switch ${idx + 1}`;
        });
        if (!battle.choose(side.id, parts.join(", "))) battle.choose(side.id, "default");
      }
      if (!any) return;
    }
  };

  for (const [ti, turn] of record.turns.entries()) {
    if (battle.ended) {
      divergence = `turn ${turn.turn}: the simulated battle already ended`;
      break;
    }
    markLogSent(battle);
    if (turn.state) {
      const err =
        syncState(battle.sides[0], turn.state[0]) ?? syncState(battle.sides[1], turn.state[1]);
      if (err) {
        divergence = `turn ${turn.turn}: ${err}`;
        break;
      }
    }
    formMap = new Map(
      battle.sides.flatMap((sd) => sd.pokemon.map((m) => [m.species.id, setSpecies(m)] as const)),
    );
    const choices: string[] = [];
    for (const s of [0, 1] as const) {
      const side = battle.sides[s];
      const req = side.activeRequest;
      if (!req?.active || req.wait || req.forceSwitch) {
        choices.push("default");
        continue;
      }
      const dist = policyDistribution(battle, side, tags, ctx.params, temperature);
      const acts = turn.actions[s];
      const nSlots = req.active.length;
      // map record actions (alive slots in order) to request slots
      const slotActs: (RecordSlotAction | null)[] = [];
      let k = 0;
      for (let i = 0; i < nSlots; i++) {
        const mon = side.active[i];
        slotActs.push(mon && !mon.fainted ? (acts[k++] ?? { unknown: true }) : null);
      }
      const picks: string[] = [];
      const matchSets: (Set<string> | null)[] = [];
      slotActs.forEach((a, i) => {
        const marg = new Map<string, { o: SlotOption; p: number }>();
        for (const j of dist) {
          const o = j.slots[i]!;
          const e = marg.get(o.choice) ?? { o, p: 0 };
          e.p += j.prob;
          marg.set(o.choice, e);
        }
        const top = [...marg.values()].sort((x, y) => y.p - x.p)[0];
        if (!a || "pass" in a) {
          picks.push(top?.o.choice ?? "pass");
          matchSets.push(null);
          return;
        }
        if ("unknown" in a) {
          metrics.unknown++;
          picks.push((top?.o.choice ?? "default").replace(/ mega$/, ""));
          matchSets.push(null);
          return;
        }
        const ms = [...marg.values()].filter((e) => matches(e.o, a));
        if (ms.length === 0) {
          metrics.unmatched++;
          picks.push((top?.o.choice ?? "default").replace(/ mega$/, ""));
          matchSets.push(null);
          return;
        }
        const p = ms.reduce((x, e) => x + e.p, 0);
        const best = Math.max(...ms.map((e) => e.p));
        const all = [...marg.values()].filter((e) => !matches(e.o, a)).map((e) => e.p);
        const rank = rankOf(best, all);
        addTo(metrics.slot, rank, p);
        addTo(metrics.byCategory[categoryOf(a, tags, battle)], rank, p);
        matchSets.push(new Set(ms.map((e) => e.o.choice)));
        picks.push(choiceFor(dist, i, a, !!req.active![i]?.canMegaEvo) ?? "default");
      });
      // joint: only when every live slot's action is known
      const live = slotActs.map((a, i) => ({ a, i })).filter((x) => x.a && !("pass" in x.a));
      if (live.length > 0 && live.every((x) => matchSets[x.i])) {
        const ok = (j: WeightedJoint) =>
          live.every((x) => matchSets[x.i]!.has(j.slots[x.i]!.choice));
        const hit = dist.filter(ok);
        const p = hit.reduce((x, j) => x + j.prob, 0);
        const best = Math.max(...hit.map((j) => j.prob));
        const rank = rankOf(
          best,
          dist.filter((j) => !ok(j)).map((j) => j.prob),
        );
        addTo(metrics.joint, rank, p);
        // focus: two attacks into the same foe
        const atk = live
          .map((x) => x.a!)
          .filter((a): a is { move: string; target?: string } => "move" in a);
        if (
          atk.length === 2 &&
          atk[0]!.target &&
          atk[0]!.target === atk[1]!.target &&
          atk.every((a) => categoryOf(a, tags, battle) === "attack") &&
          side.foe.active.some((f) => f && !f.fainted && setSpecies(f) === atk[0]!.target)
        )
          addTo(metrics.byCategory.focus, rank, p);
      }
      choices.push(dedupe(picks).join(", "));
    }
    // Run the turn. Our dice differ from the real battle's, so when the outcome (who is active
    // next turn, whether the battle ended) disagrees with the record, retry the turn from the same
    // position with other dice (weights.simulation.evalReplayRetries).
    const next = record.turns[ti + 1];
    const before = snap(battle);
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        battle = restore(before);
        reseed(battle, mixSeed(seed, turn.turn, attempt));
      }
      for (const s of [0, 1] as const) {
        const id = s === 0 ? "p1" : "p2";
        if (battle.sides[s].isChoiceDone()) continue;
        if (!battle.choose(id, choices[s]!)) battle.choose(id, "default");
      }
      replacements[0] = [...(turn.replacements?.[0] ?? [])];
      replacements[1] = [...(turn.replacements?.[1] ?? [])];
      forcedSwitches();
      if (agrees(battle, next)) break;
    }
    evaluated++;
  }
  return {
    id: record.id,
    turnsEvaluated: evaluated,
    turnsTotal: record.turns.length,
    ...(divergence ? { divergence } : {}),
    actions: metrics,
  };
}

/** Does the simulated position match the record's next turn (same active Pokémon, not ended)? */
function agrees(b: PsBattle, next: BattleRecord["turns"][number] | undefined): boolean {
  if (!next) return true;
  if (b.ended) return false;
  if (!next.state) return true;
  return ([0, 1] as const).every((s) => {
    const sim = b.sides[s].active
      .filter((m): m is PsPokemon => !!m && !m.fainted)
      .map(setSpecies)
      .sort()
      .join();
    return (
      sim ===
      next
        .state![s].map((m) => m.species)
        .sort()
        .join()
    );
  });
}

function dedupe(choices: string[]): string[] {
  let used = false;
  return choices.map((c) => {
    if (!c.endsWith(" mega")) return c;
    if (used) return c.slice(0, -5);
    used = true;
    return c;
  });
}

/** Where the recorded bring/leads rank in a matchup analysis (screening order). */
export function selectionRanks(
  analysis: MatchupAnalysis,
  record: BattleRecord,
  teams: [PokemonSet[], PokemonSet[]],
): SelectionRank[] {
  const out: SelectionRank[] = [];
  for (const side of [0, 1] as const) {
    const brought = record.brought[side];
    if (brought.length < 4) continue;
    const list = side === 0 ? analysis.screening.mine : analysis.screening.theirs;
    const cfg = configOf(teams[side], brought);
    const key4 = (c: readonly number[]) => [...c].sort((a, b) => a - b).join(",");
    const keyLead = (c: readonly number[]) => [c[0]!, c[1]!].sort((a, b) => a - b).join(",");
    const fours: string[] = [];
    for (const s of list) if (!fours.includes(key4(s.config))) fours.push(key4(s.config));
    const configRank =
      list.findIndex((s) => key4(s.config) === key4(cfg) && keyLead(s.config) === keyLead(cfg)) + 1;
    const sameFour = list.filter((s) => key4(s.config) === key4(cfg));
    const leadRank = sameFour.findIndex((s) => keyLead(s.config) === keyLead(cfg)) + 1;
    const matrix = side === 0 ? analysis.matrix.mine : analysis.matrix.theirs;
    const eq = side === 0 ? analysis.equilibrium.mine : analysis.equilibrium.theirs;
    const want = cfg.map((i) => teams[side][i]!.species);
    const mi = matrix.findIndex(
      (sp) =>
        [...sp].sort().join() === [...want].sort().join() &&
        [sp[0], sp[1]].sort().join() === [want[0], want[1]].sort().join(),
    );
    out.push({
      side,
      fourRank: fours.indexOf(key4(cfg)) + 1,
      fours: fours.length,
      configRank,
      configs: list.length,
      leadRank,
      leads: sameFour.length,
      ...(mi >= 0 ? { eqProb: r4(eq[mi]!) } : {}),
    });
  }
  return out;
}

/** Aggregate per-record results. */
export function summarize(
  regulationId: string,
  temperature: number,
  perRecord: RecordEval[],
): EvalSummary {
  const actions = actionMetrics();
  for (const r of perRecord) mergeActionMetrics(actions, r.actions);
  const sel = perRecord.flatMap((r) => r.selection);
  const mean = (xs: number[]) => (xs.length ? r4(xs.reduce((a, x) => a + x, 0) / xs.length) : 0);
  const frac = (f: (s: SelectionRank) => boolean) =>
    sel.length ? r4(sel.filter(f).length / sel.length) : 0;
  return {
    regulationId,
    temperature,
    records: perRecord.length,
    actions,
    rates: {
      slot: tallyRates(actions.slot),
      joint: tallyRates(actions.joint),
      byCategory: Object.fromEntries(
        Object.entries(actions.byCategory).map(([k, t]) => [k, tallyRates(t)]),
      ),
    },
    selection: {
      n: sel.length,
      fourTop1: frac((s) => s.fourRank === 1),
      fourTop3: frac((s) => s.fourRank >= 1 && s.fourRank <= 3),
      meanFourRank: mean(sel.map((s) => s.fourRank)),
      configTop3: frac((s) => s.configRank >= 1 && s.configRank <= 3),
      meanConfigRank: mean(sel.map((s) => s.configRank)),
      leadTop1: frac((s) => s.leadRank === 1),
      meanLeadRank: mean(sel.map((s) => s.leadRank)),
    },
    perRecord,
  };
}

/** Differences of the headline rates between two summaries (after − before). */
export function compareSummaries(
  before: Pick<EvalSummary, "rates" | "selection">,
  after: Pick<EvalSummary, "rates" | "selection">,
): { metric: string; before: number; after: number; delta: number }[] {
  const rows: { metric: string; before: number; after: number; delta: number }[] = [];
  const push = (metric: string, b: number | undefined, a: number | undefined) => {
    if (b === undefined || a === undefined) return;
    rows.push({ metric, before: b, after: a, delta: r4(a - b) });
  };
  for (const k of ["slot", "joint"] as const)
    for (const m of ["top1", "top3", "meanLogProb"] as const)
      push(`${k}.${m}`, before.rates[k][m], after.rates[k][m]);
  for (const c of Object.keys(after.rates.byCategory))
    push(`category.${c}.top1`, before.rates.byCategory[c]?.top1, after.rates.byCategory[c]?.top1);
  if (before.selection.n && after.selection.n)
    for (const m of ["fourTop1", "fourTop3", "meanFourRank", "configTop3", "leadTop1"] as const)
      push(`selection.${m}`, before.selection[m], after.selection[m]);
  return rows;
}
