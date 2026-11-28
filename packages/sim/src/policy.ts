import type { EngineTags } from "@ca/schema";
import type { PsBattle, PsMove, PsPokemon, PsRequest, PsRequestMove, PsSide } from "./showdown.js";
import type { Rng } from "./rng.js";

/** Policy parameters (weights.json `simulation`). */
export type PolicyParams = Record<string, number>;

/** Damage one option deals to one foe (for scoring both slots together). */
export interface Hit {
  /** index into side.foe.active */
  foe: number;
  dmg: number;
  hp: number;
  maxhp: number;
}

export interface SlotOption {
  /** Showdown choice fragment, e.g. "move 1 2 mega" or "switch 3". */
  choice: string;
  /** Human-readable: move ID + target species ID. */
  moveId?: string;
  targetSpecies?: string;
  switchTo?: string;
  score: number;
  /** What the damage part of `score` is made of (joint scoring re-adds it per foe). */
  hits?: Hit[];
  /** Probability this slot gets to act before being KO'd (R-1); damage value is weighted by it. */
  acts?: number;
  /** ally-hit penalty already subtracted from `score` (undone if the ally protects) */
  allyPenalty?: number;
  kind?: "attack" | "protect" | "switch" | "redirect" | "setup" | "status";
}

export interface JointOption {
  choice: string;
  slots: SlotOption[];
  score: number;
}

export const PROTECT = new Set([
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
  if (params["damageModel"] === 1) return showdownDamage(b, atk, def, move, tags, spreadTargets);
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

interface PsDamageInternals {
  prng: { clone(): unknown };
  randomizer(d: number): number;
  trunc(x: number): number;
  dex: { getActiveMove(id: string): Record<string, unknown> };
  actions: {
    getDamage(src: PsPokemon, tgt: PsPokemon, move: unknown, quiet: boolean): unknown;
  };
  singleEvent(e: string, ...args: unknown[]): unknown;
  runEvent(e: string, ...args: unknown[]): unknown;
  activeMove: unknown;
  activePokemon: unknown;
  activeTarget: unknown;
}

/**
 * R-4: expected damage as Showdown computes it (all modifiers: items, abilities, terrain, screens,
 * Helping Hand, boosts, weather …), with the mean damage roll, no random crit (always-crit moves
 * still crit) and Showdown's PRNG untouched. Multi-hit: 2–5 hits count as 3, each hit computed.
 * Times accuracy.
 */
export function showdownDamage(
  b: PsBattle,
  atk: PsPokemon,
  def: PsPokemon,
  move: PsMove,
  tags: EngineTags,
  spreadTargets: number,
): number {
  const bb = b as unknown as PsDamageInternals;
  const savedPrng = bb.prng;
  const hadOwn = Object.prototype.hasOwnProperty.call(bb, "randomizer");
  const savedRandomizer = bb.randomizer;
  const savedActive = [bb.activeMove, bb.activePokemon, bb.activeTarget] as const;
  bb.prng = savedPrng.clone() as PsDamageInternals["prng"];
  bb.randomizer = (d: number) => bb.trunc(bb.trunc(d * 92.5) / 100);
  try {
    const active = bb.dex.getActiveMove(move.id);
    // some handlers read the move being used from the battle
    bb.activeMove = active;
    bb.activePokemon = atk;
    bb.activeTarget = def;
    // -ate abilities, Weather Ball …: type and power are set by ModifyType / ModifyMove events
    // before damage, as in Showdown's runMove
    bb.singleEvent("ModifyType", active, null, atk, def, active, active);
    bb.runEvent("ModifyType", atk, def, active, active);
    bb.singleEvent("ModifyMove", active, null, atk, def, active, active);
    bb.runEvent("ModifyMove", atk, def, active, active);
    const type = active["type"] as string;
    if (tags.abilities.typeImmunity[def.ability] === type) return 0;
    if (active["willCrit"] === undefined) active["willCrit"] = false;
    active["spreadHit"] = spreadTargets > 1;
    const mh = move.multihit;
    const hits = Array.isArray(mh) ? (atk.ability === "skilllink" ? mh[1] : 3) : (mh ?? 1);
    let total = 0;
    for (let h = 1; h <= hits; h++) {
      active["hit"] = h;
      const d = bb.actions.getDamage(atk, def, active, true);
      if (typeof d !== "number") return 0;
      total += d;
    }
    const acc = move.accuracy === true ? 1 : move.accuracy / 100;
    return total * acc;
  } finally {
    [bb.activeMove, bb.activePokemon, bb.activeTarget] = savedActive;
    bb.prng = savedPrng;
    if (hadOwn) bb.randomizer = savedRandomizer;
    else delete (bb as Partial<PsDamageInternals>).randomizer;
  }
}

/** Turn order of one action as Showdown computes it (priority incl. Prankster etc., speed incl.
 * Tailwind, Trick Room, paralysis, Choice Scarf). */
export interface ActionOrder {
  priority: number;
  speed: number;
}

interface PsInternals {
  prng: { clone(): unknown };
  getActionSpeed(a: Record<string, unknown>): void;
  dex: { getActiveMove(id: string): unknown };
}

/** Showdown's own priority/speed for `mon` using `moveId` (no battle state or RNG is changed). */
export function actionOrder(
  b: PsBattle,
  mon: PsPokemon,
  moveId: string,
  targetLoc: number,
): ActionOrder {
  const bb = b as unknown as PsInternals;
  const saved = bb.prng;
  bb.prng = saved.clone() as PsInternals["prng"];
  try {
    const action: Record<string, unknown> = {
      choice: "move",
      move: bb.dex.getActiveMove(moveId),
      pokemon: mon,
      targetLoc,
      fractionalPriority: 0,
      order: 200,
    };
    bb.getActionSpeed(action);
    return { priority: action["priority"] as number, speed: action["speed"] as number };
  } finally {
    bb.prng = saved;
  }
}

/** Probability that `x` moves before `y` (speed ties are coin flips). */
export function movesFirst(x: ActionOrder, y: ActionOrder): number {
  if (x.priority !== y.priority) return x.priority > y.priority ? 1 : 0;
  if (x.speed !== y.speed) return x.speed > y.speed ? 1 : 0;
  return 0.5;
}

/** Foe position number for a targeted choice (Showdown target loc 1/2). */
const locOf = (side: PsSide, foe: PsPokemon) => side.foe.active.indexOf(foe) + 1;

/** A foe move that is expected to KO `mon`, with its turn order. */
interface KoThreat {
  order: ActionOrder;
}

/** Largest fraction of `mon`'s current HP any foe could take with one move, and the KO moves. */
function threatsTo(
  b: PsBattle,
  side: PsSide,
  mon: PsPokemon,
  foes: PsPokemon[],
  tags: EngineTags,
  params: PolicyParams,
): { worst: number; ko: KoThreat[] } {
  let worst = 0;
  const ko: KoThreat[] = [];
  const myLoc = side.active.indexOf(mon) + 1;
  for (const f of foes) {
    for (const ms of (f as unknown as { moveSlots: { id: string }[] }).moveSlots ?? []) {
      const mv = b.dex.moves.get(ms.id);
      const frac = estimateDamage(b, f, mon, mv, tags, params, 1) / Math.max(1, mon.hp);
      worst = Math.max(worst, frac);
      if (frac >= 1) ko.push({ order: actionOrder(b, f, mv.id, myLoc) });
    }
  }
  return { worst, ko };
}

/** The foe move doing the largest fraction of `mon`'s max HP. */
function worstMoveAgainst(
  b: PsBattle,
  mon: PsPokemon,
  foes: PsPokemon[],
  tags: EngineTags,
  params: PolicyParams,
): { foe: PsPokemon; move: PsMove; frac: number } | undefined {
  let best: { foe: PsPokemon; move: PsMove; frac: number } | undefined;
  for (const f of foes)
    for (const ms of (f as unknown as { moveSlots: { id: string }[] }).moveSlots ?? []) {
      const mv = b.dex.moves.get(ms.id);
      const frac = estimateDamage(b, f, mon, mv, tags, params, 1) / mon.maxhp;
      if (frac > 0 && (!best || frac > best.frac)) best = { foe: f, move: mv, frac };
    }
  return best;
}

/** Probability `mon`, acting with `order`, is not KO'd first (any single faster KO move). */
function actsBeforeKo(order: ActionOrder, ko: KoThreat[]): number {
  let outsped = 0;
  for (const t of ko) outsped = Math.max(outsped, movesFirst(t.order, order));
  return 1 - outsped;
}

const alive = (xs: (PsPokemon | null)[]) =>
  xs.filter((x): x is PsPokemon => !!x && !x.fainted && x.hp > 0);

/**
 * Chance that expected damage `d` KOs a foe with `hp` left. The estimate is a mean (rolls, crits,
 * accuracy, Protect and switching all add spread), so the KO is not 0/1 at d = hp: it rises
 * linearly from d = hp·(1−w) to d = hp·(1+w), w = weights.simulation.koSpread.
 */
export function koChance(d: number, hp: number, spread: number): number {
  if (hp <= 0) return 1;
  if (spread <= 0) return d >= hp ? 1 : 0;
  return Math.min(1, Math.max(0, (d / hp - (1 - spread)) / (2 * spread)));
}

/** Value of dealing `d` damage to a foe: HP fraction taken plus the KO bonus × KO chance. */
const hitValue = (h: { hp: number; maxhp: number }, d: number, koBonus: number, spread: number) =>
  Math.min(d, h.hp) / h.maxhp + koBonus * koChance(d, h.hp, spread);

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
  const threat = threatsTo(b, side, me, liveFoes, tags, params);
  const myThreat = threat.worst;
  const koBonus = p(params, "koBonus");
  const discount = p(params, "outspedKoDiscount");
  const spread = p(params, "koSpread");
  // R-1: chance I am KO'd before a normal-priority action of mine
  const baseOrder: ActionOrder = {
    priority: 0,
    speed: (me as unknown as { getActionSpeed(): number }).getActionSpeed(),
  };
  const koFirst = 1 - actsBeforeKo(baseOrder, threat.ko);
  active.moves.forEach((rm: PsRequestMove, i) => {
    if (rm.disabled) return;
    const dexMove = b.dex.moves.get(rm.id);
    // Locked moves (charging turn 2, Outrage…) come without `target` and must not be targeted.
    const mv: PsMove = { ...dexMove, target: rm.target ?? "self" };
    const n = i + 1;
    if (mv.category !== "Status") {
      const firstFoe = liveFoes[0];
      const order = actionOrder(b, me, mv.id, firstFoe ? locOf(side, firstFoe) : 0);
      // R-1: damage only counts if I get to move; faster KO threats discount it.
      const acts = 1 - discount * (1 - actsBeforeKo(order, threat.ko));
      const prioKo = order.priority > 0 ? p(params, "priorityKoBonus") : 0;
      const dmgTo = (t: PsPokemon, k: number) => estimateDamage(b, me, t, mv, tags, params, k);
      const hit = (t: PsPokemon, d: number): Hit => ({
        foe: foes.indexOf(t),
        dmg: d,
        hp: t.hp,
        maxhp: t.maxhp,
      });
      const valueOf = (hs: Hit[]) =>
        hs.reduce(
          (a, h) =>
            a +
            acts * (hitValue(h, h.dmg, koBonus, spread) + prioKo * koChance(h.dmg, h.hp, spread)),
          0,
        );
      if (SPREAD_TARGETS.has(mv.target)) {
        const targets =
          mv.target === "allAdjacent"
            ? [...liveFoes, ...(ally && !ally.fainted ? [ally] : [])]
            : liveFoes;
        const hits = liveFoes.map((t) => hit(t, dmgTo(t, targets.length)));
        let score = valueOf(hits);
        let allyPenalty = 0;
        if (mv.target === "allAdjacent" && ally && !ally.fainted) {
          allyPenalty =
            p(params, "allyHitPenalty") *
            hitValue(ally, dmgTo(ally, targets.length), koBonus, spread);
          score -= allyPenalty;
        }
        if (tags.moves.speedControl[mv.id]) score += p(params, "speedDropBonus") * liveFoes.length;
        if (mv.id === "fakeout")
          score += me.activeMoveActions === 0 ? p(params, "fakeOutValue") : -5;
        out.push({
          choice: `move ${n}${mega}`,
          moveId: mv.id,
          score,
          hits,
          acts,
          ...(allyPenalty ? { allyPenalty } : {}),
          kind: "attack",
        });
      } else if (NEEDS_TARGET.has(mv.target)) {
        foes.forEach((t, ti) => {
          if (!t || t.fainted) return;
          const hits = [hit(t, dmgTo(t, 1))];
          let score = valueOf(hits);
          if (mv.id === "fakeout")
            score += me.activeMoveActions === 0 ? p(params, "fakeOutValue") : -5;
          if (tags.moves.speedControl[mv.id]) score += p(params, "speedDropBonus");
          out.push({
            choice: `move ${n} ${ti + 1}${mega}`,
            moveId: mv.id,
            targetSpecies: t.species.id,
            score,
            hits,
            acts,
            kind: "attack",
          });
        });
      } else {
        const t = liveFoes[0];
        if (t) {
          const hits = [hit(t, dmgTo(t, 1))];
          out.push({
            choice: `move ${n}${mega}`,
            moveId: mv.id,
            score: valueOf(hits),
            hits,
            acts,
            kind: "attack",
          });
        }
      }
      return;
    }
    // status moves
    let score = p(params, "statusMoveValue");
    let kind: SlotOption["kind"] = "status";
    let target = "";
    if (PROTECT.has(mv.id)) {
      kind = "protect";
      score =
        p(params, "protectBase") +
        (myThreat >= 1
          ? p(params, "protectThreatBonus")
          : myThreat * p(params, "protectThreatBonus") * 0.5) +
        koFirst * p(params, "outspedProtectBonus");
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
      kind = "redirect";
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
      kind = "setup";
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
    out.push({ choice: `move ${n}${target}${mega}`, moveId: mv.id, score, kind });
  });
  // Voluntary switches: low base value, more attractive when this Pokémon is likely to be KO'd.
  if (!active.trapped && params["switchBase"] !== undefined) {
    // R-5: compare the switch-in with staying in (matchup, resisting the biggest threat, Intimidate)
    const wMatch = p(params, "switchMatchupWeight");
    const wResist = p(params, "switchResistBonus");
    const wIntim = p(params, "intimidateCycleBonus");
    const mine = wMatch ? switchMatchup(b, side, me, tags, params) : 0;
    const worst = wResist ? worstMoveAgainst(b, me, liveFoes, tags, params) : undefined;
    const foePhysical = liveFoes.some((f) =>
      ((f as unknown as { moveSlots?: { id: string }[] }).moveSlots ?? []).some(
        (x) => b.dex.moves.get(x.id).category === "Physical",
      ),
    );
    req.side.pokemon.forEach((pk, i) => {
      if (pk.active || pk.condition.endsWith(" fnt")) return;
      const mon = side.pokemon[i];
      if (!mon) return;
      let score =
        p(params, "switchBase") +
        (myThreat >= 1 ? p(params, "switchThreatBonus") : 0) +
        koFirst * p(params, "outspedSwitchBonus");
      if (wMatch) score += wMatch * (switchMatchup(b, side, mon, tags, params) - mine);
      if (worst) {
        const taken = estimateDamage(b, worst.foe, mon, worst.move, tags, params, 1) / mon.maxhp;
        if (taken <= p(params, "switchResistRatio") * worst.frac) score += wResist;
      }
      if (wIntim && mon.ability === "intimidate" && foePhysical) score += wIntim;
      out.push({ choice: `switch ${i + 1}`, switchTo: mon.species.id, score, kind: "switch" });
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

/**
 * R-2: score both slots' actions together. Starts from the sum of the slot scores, then for every
 * foe hit by both slots replaces the two separate damage values with the value of the combined
 * damage (capped at the foe's HP, KO bonus once), penalizes attacking a foe one slot KOs alone
 * (overkill), rewards KOs that need both (focus), undoes the ally-hit penalty when the ally
 * protects, and rewards redirection + setup/attack.
 */
export function jointScore(slots: SlotOption[], params: PolicyParams): number {
  let score = slots.reduce((a, s) => a + s.score, 0);
  if (slots.length !== 2) return score;
  const [x, y] = slots as [SlotOption, SlotOption];
  const koBonus = p(params, "koBonus");
  const spread = p(params, "koSpread");
  const interaction = p(params, "jointInteraction");
  const wx = x.acts ?? 1;
  const wy = y.acts ?? 1;
  for (const hx of x.hits ?? []) {
    const hy = (y.hits ?? []).find((h) => h.foe === hx.foe);
    if (!hy) continue;
    const vx = hitValue(hx, hx.dmg, koBonus, spread);
    const vy = hitValue(hy, hy.dmg, koBonus, spread);
    // Each slot acts with probability w; then (sharing a target) the combined damage is worth
    // V(dx+dy), not V(dx)+V(dy). The interaction is scaled by `jointInteraction`: an estimated KO
    // is far from certain (misses, Protect, switches, rolls), so backup damage keeps some value.
    const both = hitValue(hx, hx.dmg + hy.dmg, koBonus, spread);
    score += interaction * wx * wy * (both - vx - vy);
    // overkill: the part of the KO one slot already secures alone; focus: what only both get
    const alone = Math.max(koChance(hx.dmg, hx.hp, spread), koChance(hy.dmg, hy.hp, spread));
    const together = koChance(hx.dmg + hy.dmg, hx.hp, spread);
    score -= wx * wy * p(params, "overkillPenalty") * alone;
    score += wx * wy * p(params, "focusKoBonus") * (together - alone);
  }
  for (const [s, other] of [
    [x, y],
    [y, x],
  ] as const) {
    if (s.allyPenalty && other.kind === "protect")
      score += p(params, "allyProtectRefund") * s.allyPenalty;
    if (s.kind === "redirect" && other.kind === "setup") score += p(params, "redirectSetupBonus");
    if (s.kind === "redirect" && other.kind === "attack") score += p(params, "redirectAttackBonus");
  }
  return score;
}

/** Every legal joint action with its joint score (unsorted, before mega dedupe). */
function enumerateJoints(
  b: PsBattle,
  side: PsSide,
  req: PsRequest,
  tags: EngineTags,
  params: PolicyParams,
): JointOption[] {
  const perSlot = (req.active ?? []).map((_, slot) =>
    slotOptions(b, side, slot, req, tags, params),
  );
  let joint: SlotOption[][] = [[]];
  for (const opts of perSlot) joint = joint.flatMap((j) => opts.map((o) => [...j, o]));
  return joint
    .filter((slots) => !conflicts(slots))
    .map((slots) => ({
      choice: dedupeMega(slots.map((s) => s.choice)).join(", "),
      slots,
      score: jointScore(slots, params),
    }));
}

const byScore = (a: JointOption, c: JointOption) =>
  c.score - a.score || a.choice.localeCompare(c.choice);

/** Selection probabilities: softmax of the scores at the given temperature. */
export function softmaxProbs(opts: { score: number }[], temperature: number): number[] {
  const max = Math.max(...opts.map((o) => o.score));
  const w = opts.map((o) => Math.exp((o.score - max) / Math.max(1e-6, temperature)));
  const total = w.reduce((a, x) => a + x, 0);
  return w.map((x) => x / total);
}

function samplePick(probs: number[], rng: Rng): number {
  let r = rng.next();
  for (let i = 0; i < probs.length; i++) {
    r -= probs[i]!;
    if (r <= 0) return i;
  }
  return probs.length - 1;
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

/**
 * R-5: how well `mon` would do on the field now: the best fraction of a foe's HP it can take with
 * one move, minus the worst fraction of its own HP a foe can take, plus the share of foes it
 * outspeeds (weights switchOffenseWeight / switchDefenseWeight / switchSpeedWeight).
 */
export function switchMatchup(
  b: PsBattle,
  side: PsSide,
  mon: PsPokemon,
  tags: EngineTags,
  params: PolicyParams,
): number {
  const foes = alive(side.foe.active);
  if (foes.length === 0) return 0;
  const moves = (m: PsPokemon) =>
    ((m as unknown as { moveSlots?: { id: string }[] }).moveSlots ?? []).map((x) =>
      b.dex.moves.get(x.id),
    );
  let offense = 0;
  for (const f of foes)
    for (const mv of moves(mon))
      offense = Math.max(
        offense,
        Math.min(1, estimateDamage(b, mon, f, mv, tags, params, 1) / Math.max(1, f.hp)),
      );
  let defense = 0;
  for (const f of foes)
    for (const mv of moves(f))
      defense = Math.max(
        defense,
        Math.min(1, estimateDamage(b, f, mon, mv, tags, params, 1) / Math.max(1, mon.hp)),
      );
  const spe = (m: PsPokemon) => (m as unknown as { getActionSpeed(): number }).getActionSpeed();
  const faster = foes.filter((f) => spe(mon) > spe(f)).length / foes.length;
  return (
    p(params, "switchOffenseWeight") * offense -
    p(params, "switchDefenseWeight") * defense +
    p(params, "switchSpeedWeight") * faster
  );
}

/** Every legal answer to a forced switch request ("switch 3, pass", …). */
export function forcedSwitchOptions(side: PsSide, req: PsRequest): string[] {
  const bench = req.side.pokemon
    .map((pk, i) => ({ pk, i }))
    .filter(({ pk }) => !pk.active && !pk.condition.endsWith(" fnt"))
    .map(({ i }) => i);
  let out: { parts: string[]; used: number[] }[] = [{ parts: [], used: [] }];
  for (const must of req.forceSwitch ?? []) {
    out = out.flatMap((o) => {
      if (!must) return [{ parts: [...o.parts, "pass"], used: o.used }];
      const free = bench.filter((i) => !o.used.includes(i));
      if (free.length === 0) return [{ parts: [...o.parts, "pass"], used: o.used }];
      return free.map((i) => ({ parts: [...o.parts, `switch ${i + 1}`], used: [...o.used, i] }));
    });
  }
  void side;
  return [...new Set(out.map((o) => o.parts.join(", ")))];
}

/**
 * Choice for a forced switch request. `forcedSwitchModel` 0: the first healthy benched Pokémon
 * (old behaviour); 1: the switch-ins with the best matchup against the foes on the field.
 */
export function switchChoice(
  b: PsBattle,
  side: PsSide,
  req: PsRequest,
  tags: EngineTags,
  params: PolicyParams,
): string {
  const opts = forcedSwitchOptions(side, req);
  if (params["forcedSwitchModel"] !== 1 || opts.length <= 1) return opts[0] ?? "pass";
  const value = new Map<number, number>();
  const of = (i: number) => {
    if (!value.has(i)) value.set(i, switchMatchup(b, side, side.pokemon[i]!, tags, params));
    return value.get(i)!;
  };
  let best = opts[0]!;
  let bestScore = -Infinity;
  for (const o of opts) {
    const score = [...o.matchAll(/switch (\d+)/g)].reduce((a, m) => a + of(Number(m[1]) - 1), 0);
    if (score > bestScore + 1e-12) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}

/** My side (p1) plays its best guess with less randomness; the opponent keeps `temperature`. */
export function sideTemperature(sideId: "p1" | "p2", params: PolicyParams): number {
  return sideId === "p1" && params["selfTemperature"] !== undefined
    ? params["selfTemperature"]
    : p(params, "temperature");
}

/** A joint action with its probability under the policy. */
export interface WeightedJoint {
  slots: SlotOption[];
  prob: number;
}

/**
 * The policy's probability distribution over joint actions at a move request: a softmax of the
 * joint scores (with no joint corrections this equals sampling each slot independently).
 */
export function policyDistribution(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
  temperature: number,
): WeightedJoint[] {
  const req = side.activeRequest;
  if (!req?.active) return [];
  const joints = enumerateJoints(b, side, req, tags, params).sort(byScore);
  const probs = softmaxProbs(joints, temperature);
  return joints.map((j, i) => ({ slots: j.slots, prob: probs[i]! }));
}

/** Sample this turn's choice for a side (joint action, R-2). */
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
  if (req.forceSwitch) return switchChoice(b, side, req, tags, params);
  if (!req.active) return "";
  const T = sideTemperature(side.id, params);
  const joints = enumerateJoints(b, side, req, tags, params).sort(byScore);
  if (joints.length === 0) return "default";
  const probs = softmaxProbs(joints, T);
  const k = samplePick(probs, rng);
  const pick = joints[k]!;
  if (trace) {
    // per-slot marginals of the joint distribution, in the report's per-slot format
    pick.slots.forEach((chosen, slot) => {
      const mon = side.active[slot];
      if (!mon || mon.fainted) return;
      const marg = new Map<string, { option: SlotOption; prob: number }>();
      joints.forEach((j, i) => {
        const o = j.slots[slot]!;
        const e = marg.get(o.choice) ?? { option: o, prob: 0 };
        e.prob += probs[i]!;
        marg.set(o.choice, e);
      });
      const options = [...marg.values()].sort(
        (a, c) => c.prob - a.prob || a.option.choice.localeCompare(c.option.choice),
      );
      trace.push({
        turn: b.turn,
        side: side.id === "p1" ? 0 : 1,
        species: mon.species.id,
        hpPct: Math.round((mon.hp / mon.maxhp) * 100),
        options,
        chosen: options.findIndex((o) => o.option.choice === chosen.choice),
      });
    });
  }
  return pick.choice;
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
  return enumerateJoints(b, side, req, tags, params).sort(byScore).slice(0, limit);
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
  const all = enumerateJoints(b, side, req, tags, params).sort(byScore);
  const picked = new Map<string, JointOption>();
  for (const j of all.slice(0, width)) picked.set(j.choice, j);
  const nSlots = req.active.length;
  for (let slot = 0; slot < nSlots; slot++) {
    const seen = new Set<string>();
    for (const j of all) {
      const c = j.slots[slot]!.choice;
      if (seen.has(c)) continue;
      seen.add(c);
      picked.set(j.choice, j);
    }
  }
  return [...picked.values()].sort(byScore);
}
