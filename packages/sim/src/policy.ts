import type { EngineTags } from "@ca/schema";
import type { PsBattle, PsMove, PsPokemon, PsRequest, PsRequestMove, PsSide } from "./showdown.js";
import type { Rng } from "./rng.js";

/** Policy parameters (weights.json `simulation`). */
export type PolicyParams = Record<string, number>;

export interface SlotOption {
  /** Showdown choice fragment, e.g. "move 1 2 mega" or "switch 3". */
  choice: string;
  /** Human-readable: move ID + target species ID. */
  moveId?: string;
  targetSpecies?: string;
  switchTo?: string;
  score: number;
}

export interface JointOption {
  choice: string;
  slots: SlotOption[];
  score: number;
}

const PROTECT = new Set([
  "protect",
  "detect",
  "spikyshield",
  "kingsshield",
  "banefulbunker",
  "silktrap",
  "burningbulwark",
  "obstruct",
]);
const SPREAD_TARGETS = new Set(["allAdjacentFoes", "allAdjacent"]);
const NEEDS_TARGET = new Set(["normal", "any", "adjacentFoe"]);

function p(params: PolicyParams, key: string): number {
  const v = params[key];
  if (v === undefined) throw new Error(`weights.simulation.${key} is missing`);
  return v;
}

/**
 * Rough expected damage (HP points) of `move` from `atk` to `def` in the current battle state.
 * Used only to rank choices; the simulator itself resolves the real outcome.
 */
export function estimateDamage(
  b: PsBattle,
  atk: PsPokemon,
  def: PsPokemon,
  move: PsMove,
  tags: EngineTags,
  params: PolicyParams,
  spreadTargets: number,
): number {
  if (move.category === "Status") return 0;
  let type = move.type;
  const ate = tags.abilities.typeChange[atk.ability];
  if (ate && type === ate.from) type = ate.to;
  const defTypes = def.getTypes();
  if (!b.dex.getImmunity(type, defTypes)) return 0;
  if (tags.abilities.typeImmunity[def.ability] === type) return 0;
  const eff = 2 ** b.dex.getEffectiveness(type, defTypes);
  const physical = move.category === "Physical";
  const A = atk.getStat(physical ? "atk" : "spa", false, true);
  const D = def.getStat(physical ? "def" : "spd", false, true);
  let bp = move.basePower || p(params, "variablePowerFallback");
  if (move.multihit) bp *= Array.isArray(move.multihit) ? 3 : move.multihit;
  let dmg = Math.floor(Math.floor((22 * bp * A) / Math.max(1, D)) / 50) + 2;
  if (spreadTargets > 1) dmg *= 0.75;
  const w = b.field.weather;
  if ((w === "sunnyday" || w === "desolateland") && type === "Fire") dmg *= 1.5;
  if ((w === "sunnyday" || w === "desolateland") && type === "Water") dmg *= 0.5;
  if ((w === "raindance" || w === "primordialsea") && type === "Water") dmg *= 1.5;
  if ((w === "raindance" || w === "primordialsea") && type === "Fire") dmg *= 0.5;
  if (move.willCrit) dmg *= 1.5;
  dmg *= 0.925; // mean random roll
  if (atk.hasType(type) || ["protean", "libero"].includes(atk.ability)) dmg *= 1.5;
  dmg *= eff;
  if (atk.status === "brn" && physical) dmg *= 0.5;
  if (atk.item === "choiceband" && physical) dmg *= 1.5;
  if (atk.item === "choicespecs" && !physical) dmg *= 1.5;
  if (atk.item === "lifeorb") dmg *= 1.3;
  if (atk.item === "expertbelt" && eff > 1) dmg *= 1.2;
  const acc = move.accuracy === true ? 1 : move.accuracy / 100;
  return dmg * acc;
}

/** Largest fraction of `mon`'s current HP any foe could take with one move (threat level). */
function threatTo(
  b: PsBattle,
  mon: PsPokemon,
  foes: PsPokemon[],
  tags: EngineTags,
  params: PolicyParams,
): number {
  let worst = 0;
  for (const f of foes) {
    for (const ms of (f as unknown as { moveSlots: { id: string }[] }).moveSlots ?? []) {
      const mv = b.dex.moves.get(ms.id);
      worst = Math.max(worst, estimateDamage(b, f, mon, mv, tags, params, 1) / Math.max(1, mon.hp));
    }
  }
  return worst;
}

const alive = (xs: (PsPokemon | null)[]) =>
  xs.filter((x): x is PsPokemon => !!x && !x.fainted && x.hp > 0);

/** Score every legal option for one active slot. */
export function slotOptions(
  b: PsBattle,
  side: PsSide,
  slot: number,
  req: PsRequest,
  tags: EngineTags,
  params: PolicyParams,
): SlotOption[] {
  const me = side.active[slot];
  const active = req.active?.[slot];
  if (!me || !active || me.fainted) return [{ choice: "pass", score: 0 }];
  const foes = side.foe.active;
  const liveFoes = alive(foes);
  const ally = side.active[1 - slot] ?? null;
  const mega = active.canMegaEvo ? " mega" : "";
  const out: SlotOption[] = [];
  const myThreat = threatTo(b, me, liveFoes, tags, params);
  active.moves.forEach((rm: PsRequestMove, i) => {
    if (rm.disabled) return;
    const dexMove = b.dex.moves.get(rm.id);
    // Locked moves (charging turn 2, Outrage…) come without `target` and must not be targeted.
    const mv: PsMove = { ...dexMove, target: rm.target ?? "self" };
    const n = i + 1;
    if (mv.category !== "Status") {
      const dmgTo = (t: PsPokemon, k: number) => estimateDamage(b, me, t, mv, tags, params, k);
      const value = (t: PsPokemon, d: number) =>
        Math.min(d, t.hp) / t.maxhp + (d >= t.hp ? p(params, "koBonus") : 0);
      if (SPREAD_TARGETS.has(mv.target)) {
        const targets =
          mv.target === "allAdjacent"
            ? [...liveFoes, ...(ally && !ally.fainted ? [ally] : [])]
            : liveFoes;
        let score = 0;
        for (const t of liveFoes) score += value(t, dmgTo(t, targets.length));
        if (mv.target === "allAdjacent" && ally && !ally.fainted)
          score -= p(params, "allyHitPenalty") * value(ally, dmgTo(ally, targets.length));
        if (tags.moves.speedControl[mv.id]) score += p(params, "speedDropBonus") * liveFoes.length;
        if (mv.id === "fakeout")
          score += me.activeMoveActions === 0 ? p(params, "fakeOutValue") : -5;
        out.push({ choice: `move ${n}${mega}`, moveId: mv.id, score });
      } else if (NEEDS_TARGET.has(mv.target)) {
        foes.forEach((t, ti) => {
          if (!t || t.fainted) return;
          let score = value(t, dmgTo(t, 1));
          if (mv.id === "fakeout")
            score += me.activeMoveActions === 0 ? p(params, "fakeOutValue") : -5;
          if (tags.moves.speedControl[mv.id]) score += p(params, "speedDropBonus");
          out.push({
            choice: `move ${n} ${ti + 1}${mega}`,
            moveId: mv.id,
            targetSpecies: t.species.id,
            score,
          });
        });
      } else {
        const t = liveFoes[0];
        if (t)
          out.push({ choice: `move ${n}${mega}`, moveId: mv.id, score: value(t, dmgTo(t, 1)) });
      }
      return;
    }
    // status moves
    let score = p(params, "statusMoveValue");
    let target = "";
    if (PROTECT.has(mv.id)) {
      score =
        p(params, "protectBase") +
        (myThreat >= 1
          ? p(params, "protectThreatBonus")
          : myThreat * p(params, "protectThreatBonus") * 0.5);
      if (me.volatiles["stall"]) score -= p(params, "protectRepeatPenalty");
    } else if (mv.id === "tailwind") {
      score = side.sideConditions["tailwind"] ? -1 : p(params, "tailwindValue");
    } else if (mv.id === "trickroom") {
      const mySpe = alive(side.active).reduce((a, x) => a + x.getStat("spe", false, true), 0);
      const foeSpe = liveFoes.reduce((a, x) => a + x.getStat("spe", false, true), 0);
      score = b.field.pseudoWeather["trickroom"]
        ? -1
        : mySpe < foeSpe
          ? p(params, "trickRoomValue")
          : -0.3;
    } else if (tags.moves.redirection.includes(mv.id)) {
      score = ally && !ally.fainted ? p(params, "redirectionValue") : -1;
    } else if (tags.moves.screens.includes(mv.id)) {
      score = side.sideConditions[mv.id] ? -1 : p(params, "screenValue");
    } else if (mv.status === "slp" || tags.moves.sleep.includes(mv.id)) {
      const sleepable = liveFoes.filter((f) => !f.status);
      score =
        sleepable.length && !b.field.terrain
          ? p(params, "sleepValue") * (mv.accuracy === true ? 1 : mv.accuracy / 100)
          : -1;
      if (sleepable[0]) target = ` ${foes.indexOf(sleepable[0]) + 1}`;
    } else if (mv.boosts && mv.target === "self") {
      score = p(params, "setupValue");
    } else if (mv.heal) {
      score = me.hp / me.maxhp < 0.5 ? p(params, "setupValue") * 2 : -0.5;
    }
    if (!target && NEEDS_TARGET.has(mv.target)) {
      const t = liveFoes[0];
      if (!t) return;
      target = ` ${foes.indexOf(t) + 1}`;
    }
    if (mv.target === "adjacentAlly") {
      if (!ally || ally.fainted) return;
      target = ` -${2 - slot}`;
    }
    out.push({ choice: `move ${n}${target}${mega}`, moveId: mv.id, score });
  });
  // Voluntary switches: low base value, more attractive when this Pokémon is likely to be KO'd.
  if (!active.trapped && params["switchBase"] !== undefined) {
    req.side.pokemon.forEach((pk, i) => {
      if (pk.active || pk.condition.endsWith(" fnt")) return;
      const mon = side.pokemon[i];
      if (!mon) return;
      const score = p(params, "switchBase") + (myThreat >= 1 ? p(params, "switchThreatBonus") : 0);
      out.push({ choice: `switch ${i + 1}`, switchTo: mon.species.id, score });
    });
  }
  if (out.length === 0) out.push({ choice: "move 1", score: 0 });
  return out.sort((a, b2) => b2.score - a.score || a.choice.localeCompare(b2.choice));
}

/** Two slots cannot switch to the same Pokémon. */
function conflicts(slots: SlotOption[]): boolean {
  const sw = slots.filter((s) => s.choice.startsWith("switch")).map((s) => s.choice);
  return new Set(sw).size !== sw.length;
}

/** Selection probabilities: softmax of the scores at the given temperature. */
export function softmaxProbs(opts: SlotOption[], temperature: number): number[] {
  const max = Math.max(...opts.map((o) => o.score));
  const w = opts.map((o) => Math.exp((o.score - max) / Math.max(1e-6, temperature)));
  const total = w.reduce((a, x) => a + x, 0);
  return w.map((x) => x / total);
}

function softmaxPick(opts: SlotOption[], temperature: number, rng: Rng): number {
  const probs = softmaxProbs(opts, temperature);
  let r = rng.next();
  for (let i = 0; i < opts.length; i++) {
    r -= probs[i]!;
    if (r <= 0) return i;
  }
  return opts.length - 1;
}

/** One recorded decision (for battle reports). */
export interface DecisionTrace {
  turn: number;
  side: 0 | 1;
  species: string;
  hpPct: number;
  options: { option: SlotOption; prob: number }[];
  chosen: number;
}

/** Choice for a forced switch request: send in the healthiest benched Pokémon. */
function switchChoice(side: PsSide, req: PsRequest): string {
  const used = new Set<number>();
  return (req.forceSwitch ?? [])
    .map((must) => {
      if (!must) return "pass";
      const idx = req.side.pokemon.findIndex(
        (pk, i) => !pk.active && !used.has(i) && !pk.condition.endsWith(" fnt"),
      );
      if (idx < 0) return "pass";
      used.add(idx);
      return `switch ${idx + 1}`;
    })
    .join(", ");
}

/** Sample this turn's choice for a side. */
export function chooseFor(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
  rng: Rng,
  trace?: DecisionTrace[],
): string {
  const req = side.activeRequest;
  if (!req || req.wait) return "";
  if (req.forceSwitch) return switchChoice(side, req);
  // My side (p1) plays its best guess with less randomness; the opponent keeps `temperature`.
  const T =
    side.id === "p1" && params["selfTemperature"] !== undefined
      ? params["selfTemperature"]
      : p(params, "temperature");
  const picks = (req.active ?? []).map((_, slot) => {
    const opts = slotOptions(b, side, slot, req, tags, params);
    const i = softmaxPick(opts, T, rng);
    const mon = side.active[slot];
    if (trace && mon && !mon.fainted) {
      const probs = softmaxProbs(opts, T);
      trace.push({
        turn: b.turn,
        side: side.id === "p1" ? 0 : 1,
        species: mon.species.id,
        hpPct: Math.round((mon.hp / mon.maxhp) * 100),
        options: opts.map((option, k) => ({ option, prob: probs[k]! })),
        chosen: i,
      });
    }
    return opts[i]!;
  });
  // resolve a double switch to the same Pokémon: the later slot takes its best other option
  if (conflicts(picks)) {
    const req2 = req;
    const slot = picks.length - 1;
    const alt = slotOptions(b, side, slot, req2, tags, params).find(
      (o) => o.choice !== picks[0]!.choice,
    );
    if (alt) picks[slot] = alt;
  }
  return dedupeMega(picks.map((x) => x.choice)).join(", ");
}

/** Only one Mega Evolution per turn/side. */
export function dedupeMega(choices: string[]): string[] {
  let used = false;
  return choices.map((c) => {
    if (!c.endsWith(" mega")) return c;
    if (used) return c.slice(0, -5);
    used = true;
    return c;
  });
}

/** Top joint options for a side (for the turn-1 decision matrix). */
export function jointOptions(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
  limit: number,
): JointOption[] {
  const req = side.activeRequest;
  if (!req?.active) return [];
  const perSlot = req.active.map((_, slot) =>
    slotOptions(b, side, slot, req, tags, params).slice(0, limit),
  );
  let joint: JointOption[] = [{ choice: "", slots: [], score: 0 }];
  for (const opts of perSlot) {
    joint = joint.flatMap((j) =>
      opts.map((o) => ({ choice: "", slots: [...j.slots, o], score: j.score + o.score })),
    );
  }
  return joint
    .filter((j) => !conflicts(j.slots))
    .map((j) => ({ ...j, choice: dedupeMega(j.slots.map((s) => s.choice)).join(", ") }))
    .sort((a, c) => c.score - a.score || a.choice.localeCompare(c.choice))
    .slice(0, limit);
}

/**
 * Broad candidate set for search: the `width` best joint actions by heuristic score, plus, for
 * every single-slot option (incl. Protect and switches), its best joint completion — so no option
 * is excluded just because the heuristic ranks it low.
 */
export function searchCandidates(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
  width: number,
): JointOption[] {
  const req = side.activeRequest;
  if (!req?.active) return [];
  const perSlot = req.active.map((_, slot) => slotOptions(b, side, slot, req, tags, params));
  let joint: JointOption[] = [{ choice: "", slots: [], score: 0 }];
  for (const opts of perSlot)
    joint = joint.flatMap((j) =>
      opts.map((o) => ({ choice: "", slots: [...j.slots, o], score: j.score + o.score })),
    );
  const all = joint
    .filter((j) => !conflicts(j.slots))
    .map((j) => ({ ...j, choice: dedupeMega(j.slots.map((s) => s.choice)).join(", ") }))
    .sort((a, c) => c.score - a.score || a.choice.localeCompare(c.choice));
  const picked = new Map<string, JointOption>();
  for (const j of all.slice(0, width)) picked.set(j.choice, j);
  perSlot.forEach((opts, slot) => {
    for (const o of opts) {
      const best = all.find((j) => j.slots[slot]?.choice === o.choice);
      if (best) picked.set(best.choice, best);
    }
  });
  return [...picked.values()].sort((a, c) => c.score - a.score || a.choice.localeCompare(c.choice));
}
