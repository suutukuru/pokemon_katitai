/**
 * Joint-action planner (policy v2, weights.json `simulation.policy` = 2).
 *
 * The v1 heuristic scored each active slot alone: both slots often attacked the same target
 * (overkill), turn order was ignored, and the opponent's likely moves did not matter.
 * v2 scores the two slots' actions together against a model of what the opponent will do:
 *  - the foe's attacks are predicted with a softmax over their damage (same estimator),
 *  - turn order comes from Showdown's own action speed (Tailwind, Trick Room, Scarf, paralysis,
 *    Swift Swim… are included) and move priority,
 *  - a KO is worth more when it lands before the target moves (its attack is denied),
 *  - damage from both slots on one target is summed and capped at its HP (no overkill credit),
 *  - Protect / switching are valued by the expected damage they avoid,
 *  - Fake Out is valued by the threat of the target it flinches, Tailwind / Trick Room by how
 *    many speed matchups they flip.
 * Every weight is read from weights.json (no tuning constants in code). Only ranking uses these
 * estimates; Showdown resolves the real outcome.
 */
import type { EngineTags } from "@ca/schema";
import type { PsBattle, PsMove, PsPokemon, PsRequest, PsSide } from "./showdown.js";
import type { DecisionTrace, JointOption, PolicyParams, SlotOption } from "./policy.js";
import type { Rng } from "./rng.js";

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
const SPREAD = new Set(["allAdjacentFoes", "allAdjacent"]);
const NEEDS_TARGET = new Set(["normal", "any", "adjacentFoe"]);
/** Type-boosting held items (×1.2). */
const TYPE_ITEMS: Record<string, string> = {
  charcoal: "Fire",
  mysticwater: "Water",
  miracleseed: "Grass",
  magnet: "Electric",
  nevermeltice: "Ice",
  blackbelt: "Fighting",
  poisonbarb: "Poison",
  softsand: "Ground",
  sharpbeak: "Flying",
  twistedspoon: "Psychic",
  silverpowder: "Bug",
  hardstone: "Rock",
  spelltag: "Ghost",
  dragonfang: "Dragon",
  blackglasses: "Dark",
  metalcoat: "Steel",
  silkscarf: "Normal",
  fairyfeather: "Fairy",
};

function p(params: PolicyParams, key: string): number {
  const v = params[key];
  if (v === undefined) throw new Error(`weights.simulation.${key} is missing`);
  return v;
}

const alive = (m: PsPokemon | null | undefined): m is PsPokemon => !!m && !m.fainted && m.hp > 0;

/** Probability that `dmg` (mean roll) KOs a target with `hp` left (rolls 85–100%). */
export function koChance(dmg: number, hp: number): number {
  if (dmg <= 0) return 0;
  const lo = dmg * (0.85 / 0.925);
  const hi = dmg * (1 / 0.925);
  if (hp <= lo) return 1;
  if (hp > hi) return 0;
  return (hi - hp) / (hi - lo);
}

function weightPower(kg: number): number {
  return kg < 10 ? 20 : kg < 25 ? 40 : kg < 50 ? 60 : kg < 100 ? 80 : kg < 200 ? 100 : 120;
}

/**
 * Expected damage (HP points, mean roll, before accuracy) of `move` from `atk` to `def`.
 * Broader than v1's estimate: common abilities, items, terrain, screens, variable-power moves.
 */
export function moveDamage(
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
  let ateBoost = 1;
  if (ate && type === ate.from) {
    type = ate.to;
    ateBoost = 1.2;
  }
  const defTypes = def.getTypes();
  const moldBreaker = ["moldbreaker", "teravolt", "turboblaze"].includes(atk.ability);
  const defAbility = moldBreaker ? "" : def.ability;
  if (!b.dex.getImmunity(type, defTypes)) return 0;
  if (type === "Ground" && def.item === "airballoon") return 0;
  if (tags.abilities.typeImmunity[defAbility] === type) return 0;
  if (move.flags["sound"] && defAbility === "soundproof") return 0;
  if (move.flags["bullet"] && defAbility === "bulletproof") return 0;
  if (move.priority > 0 && tags.abilities.priorityBlock.includes(defAbility)) return 0;
  const eff = 2 ** b.dex.getEffectiveness(type, defTypes);
  if (defAbility === "wonderguard" && eff <= 1) return 0;
  const physical = move.category === "Physical";
  const usesDef = physical || ["psyshock", "psystrike", "secretsword"].includes(move.id);
  let A = atk.getStat(physical ? "atk" : "spa", false, true);
  const D = def.getStat(usesDef ? "def" : "spd", false, true);
  const fieldW = b.field.weather;
  const sun = fieldW === "sunnyday" || fieldW === "desolateland";
  const rain = fieldW === "raindance" || fieldW === "primordialsea";

  let bp = move.basePower;
  switch (move.id) {
    case "lastrespects":
      bp = 50 + 50 * ((atk.side as unknown as { totalFainted?: number }).totalFainted ?? 0);
      break;
    case "lowkick":
    case "grassknot":
      bp = weightPower(def.species.weightkg ?? 50);
      break;
    case "acrobatics":
      if (!atk.item) bp *= 2;
      break;
    case "knockoff":
      if (def.item) bp *= 1.5;
      break;
    case "facade":
      if (atk.status) bp *= 2;
      break;
    case "hex":
      if (def.status) bp *= 2;
      break;
    case "weatherball":
      if (fieldW) {
        bp = 100;
        type = sun ? "Fire" : rain ? "Water" : type;
      }
      break;
  }
  if (!bp) bp = p(params, "variablePowerFallback");
  if (move.multihit)
    bp *= Array.isArray(move.multihit) ? (move.multihit[1] >= 5 ? 3 : 2) : move.multihit;
  // attacker abilities
  switch (atk.ability) {
    case "hugepower":
    case "purepower":
      if (physical) A *= 2;
      break;
    case "technician":
      if (bp <= 60) bp *= 1.5;
      break;
    case "toughclaws":
      if (move.flags["contact"]) bp *= 1.3;
      break;
    case "ironfist":
      if (move.flags["punch"]) bp *= 1.2;
      break;
    case "strongjaw":
      if (move.flags["bite"]) bp *= 1.5;
      break;
    case "sharpness":
      if (move.flags["slicing"]) bp *= 1.5;
      break;
    case "megalauncher":
      if (move.flags["pulse"]) bp *= 1.5;
      break;
    case "punkrock":
      if (move.flags["sound"]) bp *= 1.3;
      break;
    case "sheerforce":
      if (move.secondary) bp *= 1.3;
      break;
    case "guts":
      if (atk.status && physical) A *= 1.5;
      break;
    case "solarpower":
      if (sun && !physical) A *= 1.5;
      break;
    case "transistor":
      if (type === "Electric") A *= 1.3;
      break;
    case "dragonsmaw":
      if (type === "Dragon") A *= 1.5;
      break;
    case "steelworker":
      if (type === "Steel") A *= 1.5;
      break;
    case "parentalbond":
      bp *= 1.25;
      break;
  }
  bp *= ateBoost;
  // defender abilities
  let defMod = 1;
  switch (defAbility) {
    case "multiscale":
    case "shadowshield":
      if (def.hp >= def.maxhp) defMod *= 0.5;
      break;
    case "filter":
    case "solidrock":
    case "prismarmor":
      if (eff > 1) defMod *= 0.75;
      break;
    case "furcoat":
      if (physical) defMod *= 0.5;
      break;
    case "icescales":
      if (!physical) defMod *= 0.5;
      break;
    case "thickfat":
      if (type === "Fire" || type === "Ice") defMod *= 0.5;
      break;
    case "heatproof":
    case "waterbubble":
      if (type === "Fire") defMod *= 0.5;
      break;
    case "fluffy":
      if (move.flags["contact"] && type !== "Fire") defMod *= 0.5;
      break;
  }
  if (def.item === "assaultvest" && !usesDef) defMod /= 1.5;
  if (def.item === "eviolite") defMod /= 1.5;

  let dmg = Math.floor(Math.floor((22 * bp * A) / Math.max(1, D)) / 50) + 2;
  if (spreadTargets > 1) dmg *= 0.75;
  if (sun && type === "Fire") dmg *= 1.5;
  if (sun && type === "Water") dmg *= 0.5;
  if (rain && type === "Water") dmg *= 1.5;
  if (rain && type === "Fire") dmg *= 0.5;
  const terrain = b.field.terrain;
  if (atk.isGrounded()) {
    if (terrain === "grassyterrain" && type === "Grass") dmg *= 1.3;
    if (terrain === "electricterrain" && type === "Electric") dmg *= 1.3;
    if (terrain === "psychicterrain" && type === "Psychic") dmg *= 1.3;
  }
  if (def.isGrounded()) {
    if (terrain === "mistyterrain" && type === "Dragon") dmg *= 0.5;
    if (terrain === "grassyterrain" && ["earthquake", "bulldoze"].includes(move.id)) dmg *= 0.5;
  }
  const defSide = def.side.sideConditions;
  if (!move.willCrit && atk.ability !== "infiltrator") {
    if (defSide["auroraveil"] || (physical ? defSide["reflect"] : defSide["lightscreen"]))
      dmg *= 2732 / 4096;
  }
  if (move.willCrit) dmg *= 1.5;
  dmg *= 0.925; // mean random roll
  const stab = atk.hasType(type) || ["protean", "libero"].includes(atk.ability);
  if (stab) dmg *= atk.ability === "adaptability" ? 2 : 1.5;
  dmg *= eff;
  if (atk.status === "brn" && physical && atk.ability !== "guts") dmg *= 0.5;
  if (atk.item === "choiceband" && physical) dmg *= 1.5;
  if (atk.item === "choicespecs" && !physical) dmg *= 1.5;
  if (atk.item === "lifeorb") dmg *= 1.3;
  if (atk.item === "expertbelt" && eff > 1) dmg *= 1.2;
  if (TYPE_ITEMS[atk.item] === type) dmg *= 1.2;
  dmg *= defMod;
  // two-turn moves without their weather take a turn to charge
  if (move.flags["charge"]) {
    const instant =
      (move.id === "electroshot" && rain) ||
      ((move.id === "solarbeam" || move.id === "solarblade") && sun) ||
      atk.item === "powerherb";
    if (!instant) dmg *= p(params, "chargeMoveFactor");
  }
  return dmg;
}

const accuracyOf = (m: PsMove) => (m.accuracy === true ? 1 : m.accuracy / 100);

/** One move a Pokémon may use, with damage per target position. */
interface Attack {
  moveId: string;
  prio: number;
  spread: boolean;
  /** expected damage (accuracy applied) to each opposing position (0/1); undefined = not hit */
  dmg: (number | undefined)[];
  /** raw mean damage before accuracy (for KO checks) */
  raw: (number | undefined)[];
  acc: number;
}

function movePriority(b: PsBattle, mon: PsPokemon, mv: PsMove, tags: EngineTags): number {
  let pr = mv.priority;
  if (mv.category === "Status" && tags.abilities.prankster.includes(mon.ability)) pr += 1;
  if (mv.id === "grassyglide" && b.field.terrain === "grassyterrain" && mon.isGrounded()) pr += 1;
  if (mon.ability === "galewings" && mv.type === "Flying" && mon.hp >= mon.maxhp) pr += 1;
  return pr;
}

/** All damaging options of `mon` against the opposing side's active positions. */
function attacksOf(
  b: PsBattle,
  mon: PsPokemon,
  foeActive: (PsPokemon | null)[],
  allyOf: PsPokemon | null,
  moveIds: string[],
  tags: EngineTags,
  params: PolicyParams,
): Attack[] {
  const out: Attack[] = [];
  const live = foeActive.filter(alive);
  for (const id of moveIds) {
    const mv = b.dex.moves.get(id);
    if (mv.category === "Status") continue;
    const acc = accuracyOf(mv);
    const prio = movePriority(b, mon, mv, tags);
    if (SPREAD.has(mv.target)) {
      const n = live.length + (mv.target === "allAdjacent" && alive(allyOf) ? 1 : 0);
      const raw = foeActive.map((f) =>
        alive(f) ? moveDamage(b, mon, f, mv, tags, params, n) : undefined,
      );
      out.push({ moveId: id, prio, spread: true, raw, dmg: raw.map((d) => d && d * acc), acc });
    } else {
      foeActive.forEach((f, i) => {
        if (!alive(f)) return;
        const raw: (number | undefined)[] = [undefined, undefined];
        raw[i] = moveDamage(b, mon, f, mv, tags, params, 1);
        out.push({ moveId: id, prio, spread: false, raw, dmg: raw.map((d) => d && d * acc), acc });
      });
    }
  }
  return out;
}

/** Fraction-of-HP value of dealing `dmg` to `t` (+ KO bonus). */
function hitValue(t: PsPokemon, dmg: number, koBonus: number): number {
  return Math.min(dmg, t.hp) / t.maxhp + koBonus * koChance(dmg, t.hp);
}

/** Probability that `a` (priority pa) acts before `bb` (priority pb). */
function actsFirst(a: PsPokemon, pa: number, bb: PsPokemon, pb: number): number {
  if (pa !== pb) return pa > pb ? 1 : 0;
  const sa = a.getActionSpeed();
  const sb = bb.getActionSpeed();
  return sa > sb ? 1 : sa < sb ? 0 : 0.5;
}

/** What a foe is expected to do this turn (attacks only; Protect is modeled separately). */
interface FoeModel {
  mon: PsPokemon;
  pos: number;
  /** attack options with selection probabilities (sum = 1 - pProtect - pOther) */
  options: { atk: Attack; q: number }[];
  pProtect: number;
  /** probability that this foe uses Fake Out on each of my positions */
  fakeOut: number[];
  /** value (my units) of the damage this foe is expected to deal this turn */
  threat: number;
}

const usableMoves = (mon: PsPokemon): string[] => {
  const lock = (mon.volatiles["choicelock"] as { move?: string } | undefined)?.move;
  const slots = (mon.moveSlots ?? []).filter((m) => m.pp > 0 && !m.disabled).map((m) => m.id);
  return lock && slots.includes(lock) ? [lock] : slots;
};

const fakeOutImmune = (t: PsPokemon) =>
  t.hasType("Ghost") ||
  ["innerfocus", "shielddust"].includes(t.ability) ||
  t.item === "covertcloak";

/** Predict the foes' attacks against my side (positions 0/1 of `mine`). */
function modelFoes(
  b: PsBattle,
  foes: (PsPokemon | null)[],
  mine: (PsPokemon | null)[],
  tags: EngineTags,
  params: PolicyParams,
): FoeModel[] {
  const koBonus = p(params, "koBonus");
  const T = p(params, "foeModelTemperature");
  const out: FoeModel[] = [];
  foes.forEach((f, pos) => {
    if (!alive(f)) return;
    const moves = usableMoves(f);
    const ally = foes[1 - pos] ?? null;
    const atks = attacksOf(b, f, mine, ally, moves, tags, params).filter(
      (a) => !(a.moveId === "fakeout" && f.activeMoveActions > 0),
    );
    const vals = atks.map((a) => {
      let v = 0;
      a.dmg.forEach((d, i) => {
        const t = mine[i];
        if (d !== undefined && alive(t)) v += hitValue(t, d, koBonus);
      });
      if (a.moveId === "fakeout") v += p(params, "fakeOutValue");
      return v;
    });
    const max = Math.max(0, ...vals);
    const w = vals.map((v) => Math.exp((v - max) / Math.max(1e-6, T)));
    const tot = w.reduce((x, y) => x + y, 0) || 1;
    const hasProtect = moves.some((m) => PROTECT.has(m)) && !f.volatiles["stall"];
    // how threatened the foe is by my side (largest fraction of its HP one of my mons can take)
    let danger = 0;
    for (const m of mine) {
      if (!alive(m)) continue;
      for (const a of attacksOf(
        b,
        m,
        foes,
        mine[1 - (m.position ?? 0)] ?? null,
        usableMoves(m),
        tags,
        params,
      )) {
        const d = a.raw[pos];
        if (d !== undefined) danger = Math.max(danger, Math.min(1, d / Math.max(1, f.hp)));
      }
    }
    const pProtect = hasProtect
      ? Math.min(
          p(params, "foeProtectMax"),
          p(params, "foeProtectBase") + p(params, "foeProtectThreat") * danger,
        )
      : 0;
    const attackShare = atks.length ? 1 - pProtect : 0;
    const options = atks.map((atk, i) => ({ atk, q: (attackShare * w[i]!) / tot }));
    const fakeOut = [0, 0];
    let threat = 0;
    for (const o of options) {
      o.atk.dmg.forEach((d, i) => {
        const t = mine[i];
        if (d === undefined || !alive(t)) return;
        threat += o.q * hitValue(t, d, koBonus);
        if (o.atk.moveId === "fakeout" && !fakeOutImmune(t)) fakeOut[i]! += o.q;
      });
    }
    out.push({ mon: f, pos, options, pProtect, fakeOut, threat });
  });
  return out;
}

/** Expected incoming damage on `m` standing in position `pos`, and KO probabilities. */
function incoming(
  foes: FoeModel[],
  m: PsPokemon,
  pos: number,
  myPrio: number,
  b: PsBattle,
  tags: EngineTags,
  params: PolicyParams,
  /** recompute damage for a Pokémon that is not the one in this position (switch-in) */
  recompute: boolean,
): { exp: number; pKO: number; pKOFirst: number; pFlinch: number } {
  let exp = 0;
  let surviveAll = 1;
  let surviveFirst = 1;
  let pFlinch = 0;
  for (const f of foes) {
    let pk = 0;
    let pkFirst = 0;
    for (const o of f.options) {
      let raw = o.atk.raw[pos];
      if (raw === undefined) continue;
      if (recompute) {
        const mv = b.dex.moves.get(o.atk.moveId);
        const n = o.atk.spread ? o.atk.raw.filter((x) => x !== undefined).length : 1;
        raw = moveDamage(b, f.mon, m, mv, tags, params, n);
      }
      const d = raw * o.atk.acc;
      exp += o.q * d;
      const k = koChance(raw, m.hp) * o.atk.acc;
      pk += o.q * k;
      pkFirst += o.q * k * actsFirst(f.mon, o.atk.prio, m, myPrio);
    }
    surviveAll *= 1 - Math.min(1, pk);
    surviveFirst *= 1 - Math.min(1, pkFirst);
    if (!recompute && myPrio < 3) pFlinch += f.fakeOut[pos] ?? 0;
  }
  const pKO = Math.max(1 - surviveAll, koChance(exp, m.hp) * 0.8);
  return { exp, pKO, pKOFirst: 1 - surviveFirst, pFlinch: Math.min(1, pFlinch) };
}

/** A candidate action for one slot with everything needed to score joint actions. */
interface Act {
  opt: SlotOption;
  kind: "attack" | "protect" | "switch" | "status" | "pass";
  prio: number;
  /** expected damage to each foe position before accounting for my own KO risk */
  dmg: (number | undefined)[];
  allyRaw: number;
  recoil: number;
  /** probability this Pokémon gets to act (not KO'd first / not flinched) */
  pAct: number;
  /** standalone value (status effects, protect/switch damage avoided, penalties) */
  base: number;
}

/** Planner per-side state for one decision. */
interface Plan {
  acts: Act[][];
  foes: FoeModel[];
  foeActive: (PsPokemon | null)[];
}

function speedPairs(mine: PsPokemon[], foes: PsPokemon[], mySpeedMul: number, invert: boolean) {
  let ahead = 0;
  let total = 0;
  for (const m of mine)
    for (const f of foes) {
      total++;
      const sm = m.getStat("spe", false, false) * mySpeedMul;
      const sf = f.getStat("spe", false, false);
      if (invert ? sm < sf : sm > sf) ahead++;
    }
  return { ahead, total };
}

function buildPlan(
  b: PsBattle,
  side: PsSide,
  req: PsRequest,
  tags: EngineTags,
  params: PolicyParams,
): Plan {
  const koBonus = p(params, "koBonus");
  const mine = side.active;
  const foeActive = side.foe.active;
  const foes = modelFoes(b, foeActive, mine, tags, params);
  const foeThreat = (pos: number) => foes.find((f) => f.pos === pos)?.threat ?? 0;
  const pProtF = (pos: number) => foes.find((f) => f.pos === pos)?.pProtect ?? 0;
  const tr = !!b.field.pseudoWeather["trickroom"];
  const myAll = side.pokemon.filter(alive);
  const foeAll = side.foe.pokemon.filter(alive);
  const offense = (m: PsPokemon, pos: number) => {
    let best = 0;
    for (const a of attacksOf(
      b,
      m,
      foeActive,
      mine[1 - pos] ?? null,
      usableMoves(m),
      tags,
      params,
    )) {
      let v = 0;
      a.dmg.forEach((d, i) => {
        const t = foeActive[i];
        if (d !== undefined && alive(t)) v += hitValue(t, d, koBonus) * (1 - pProtF(i));
      });
      best = Math.max(best, v);
    }
    return best;
  };

  const acts = (req.active ?? []).map((active, slot): Act[] => {
    const me = mine[slot];
    if (!alive(me) || !active)
      return [
        {
          opt: { choice: "pass", score: 0 },
          kind: "pass",
          prio: 0,
          dmg: [],
          allyRaw: 0,
          recoil: 0,
          pAct: 0,
          base: 0,
        },
      ];
    const ally = mine[1 - slot] ?? null;
    const mega = active.canMegaEvo ? " mega" : "";
    const out: Act[] = [];
    const inc = (prio: number) => incoming(foes, me, slot, prio, b, tags, params, false);
    const selfLoss = (x: { exp: number; pKO: number }) =>
      Math.min(x.exp, me.hp) / me.maxhp + koBonus * x.pKO;
    const stallCounter = (me.volatiles["stall"] as { counter?: number } | undefined)?.counter ?? 1;
    active.moves.forEach((rm, i) => {
      if (rm.disabled) return;
      const dexMove = b.dex.moves.get(rm.id);
      const mv: PsMove = { ...dexMove, target: rm.target ?? "self" };
      const n = i + 1;
      const prio = movePriority(b, me, mv, tags);
      const x = inc(prio);
      const pAct = (1 - x.pKOFirst) * (1 - x.pFlinch);
      if (mv.category !== "Status") {
        const atks = attacksOf(b, me, foeActive, ally, [mv.id], tags, params);
        const recoilFrac = mv.recoil ? mv.recoil[0] / mv.recoil[1] : 0;
        const lifeOrb = me.item === "lifeorb" ? 0.1 : 0;
        for (const a of atks) {
          let base = 0;
          let allyRaw = 0;
          if (a.spread && mv.target === "allAdjacent" && alive(ally)) {
            const nT = foeActive.filter(alive).length + 1;
            allyRaw = moveDamage(b, me, ally, mv, tags, params, nT) * a.acc;
          }
          if (mv.id === "fakeout") {
            if (me.activeMoveActions > 0) base -= 5;
            else
              a.dmg.forEach((d, fi) => {
                const t = foeActive[fi];
                if (d !== undefined && alive(t) && !fakeOutImmune(t))
                  base += p(params, "fakeOutWeight") * foeThreat(fi) * (1 - pProtF(fi)) * pAct;
              });
          }
          if (tags.moves.speedControl[mv.id])
            base += p(params, "speedDropBonus") * a.dmg.filter((d) => d !== undefined).length;
          const hits = a.dmg.filter((d) => d !== undefined).length;
          const targetPos = a.spread ? -1 : a.dmg.findIndex((d) => d !== undefined);
          const tgt = targetPos >= 0 ? foeActive[targetPos] : undefined;
          const choice = a.spread
            ? `move ${n}${mega}`
            : NEEDS_TARGET.has(mv.target)
              ? `move ${n} ${targetPos + 1}${mega}`
              : `move ${n}${mega}`;
          if (!a.spread && !NEEDS_TARGET.has(mv.target) && out.some((o) => o.opt.choice === choice))
            continue;
          if (hits === 0 && !a.spread) continue;
          out.push({
            opt: {
              choice,
              moveId: mv.id,
              ...(tgt && NEEDS_TARGET.has(mv.target) ? { targetSpecies: tgt.species.id } : {}),
              score: 0,
            },
            kind: "attack",
            prio,
            dmg: a.dmg,
            allyRaw,
            recoil: recoilFrac + lifeOrb,
            pAct,
            base,
          });
        }
        if (atks.length === 0)
          // every target is immune: still a legal (bad) choice
          out.push({
            opt: {
              choice:
                NEEDS_TARGET.has(mv.target) && foeActive.some(alive)
                  ? `move ${n} ${foeActive.findIndex(alive) + 1}${mega}`
                  : `move ${n}${mega}`,
              moveId: mv.id,
              score: 0,
            },
            kind: "attack",
            prio,
            dmg: [],
            allyRaw: 0,
            recoil: 0,
            pAct,
            base: -1,
          });
        return;
      }
      // status moves
      let base = p(params, "statusMoveValue");
      let kind: Act["kind"] = "status";
      let target = "";
      const liveFoes = foeActive.filter(alive);
      if (PROTECT.has(mv.id)) {
        kind = "protect";
        const success = 1 / stallCounter;
        base = success * p(params, "protectWeight") * selfLoss(inc(4)) - p(params, "protectCost");
      } else if (mv.id === "tailwind") {
        if (side.sideConditions["tailwind"] || tr) base = -1;
        else {
          const now = speedPairs(myAll, foeAll, 1, false);
          const after = speedPairs(myAll, foeAll, 2, false);
          base =
            p(params, "tailwindValue") * ((after.ahead - now.ahead) / Math.max(1, now.total)) * 2;
        }
      } else if (mv.id === "trickroom") {
        const now = speedPairs(myAll, foeAll, 1, tr);
        const after = speedPairs(myAll, foeAll, 1, !tr);
        base =
          p(params, "trickRoomValue") * ((after.ahead - now.ahead) / Math.max(1, now.total)) * 2;
      } else if (tags.moves.redirection.includes(mv.id)) {
        base = alive(ally)
          ? p(params, "redirectionValue") *
            (1 + selfLossOf(foes, ally, 1 - slot, b, tags, params, koBonus))
          : -1;
      } else if (tags.moves.screens.includes(mv.id)) {
        base = side.sideConditions[mv.id]
          ? -1
          : p(params, "screenValue") * (1 + foes.reduce((s, f) => s + f.threat, 0));
      } else if (mv.status === "slp" || tags.moves.sleep.includes(mv.id)) {
        let best = -1;
        let bestPos = -1;
        foeActive.forEach((f, fi) => {
          if (!alive(f) || f.status) return;
          if (
            mv.flags["powder"] &&
            (f.hasType("Grass") || f.item === "safetygoggles" || f.ability === "overcoat")
          )
            return;
          const v =
            p(params, "sleepValue") * accuracyOf(mv) * (1 + foeThreat(fi)) * (1 - pProtF(fi));
          if (v > best) {
            best = v;
            bestPos = fi;
          }
        });
        const terrainBlocks =
          b.field.terrain === "electricterrain" || b.field.terrain === "mistyterrain";
        base = bestPos >= 0 && !terrainBlocks ? best : -1;
        if (bestPos >= 0) target = ` ${bestPos + 1}`;
      } else if (mv.boosts && mv.target === "self") {
        base = p(params, "setupValue") * (1 - x.pKO) * 2 - p(params, "setupValue") * 0.5;
      } else if (mv.heal) {
        base = me.hp / me.maxhp < 0.5 ? p(params, "setupValue") * 2 : -0.5;
      }
      base *= kind === "protect" ? 1 : pAct;
      if (!target && NEEDS_TARGET.has(mv.target)) {
        const t = liveFoes[0];
        if (!t) return;
        target = ` ${foeActive.indexOf(t) + 1}`;
      }
      if (mv.target === "adjacentAlly") {
        if (!alive(ally)) return;
        target = ` -${2 - slot}`;
      }
      out.push({
        opt: { choice: `move ${n}${target}${mega}`, moveId: mv.id, score: 0 },
        kind,
        prio: kind === "protect" ? 4 : prio,
        dmg: [],
        allyRaw: 0,
        recoil: 0,
        pAct: kind === "protect" ? 0 : pAct,
        base,
      });
    });
    // voluntary switches: avoid the expected damage, keep the switched-in mon's offense
    if (!active.trapped) {
      const here = selfLoss(inc(0));
      const off = offense(me, slot);
      req.side.pokemon.forEach((pk, i) => {
        if (pk.active || pk.condition.endsWith(" fnt")) return;
        const mon = side.pokemon[i];
        if (!alive(mon)) return;
        const inX = incoming(foes, mon, slot, 7, b, tags, params, true);
        const taken = Math.min(inX.exp, mon.hp) / mon.maxhp + koBonus * inX.pKO;
        const base =
          here -
          taken -
          p(params, "switchCost") +
          p(params, "switchOffenseWeight") * (offense(mon, slot) - off);
        out.push({
          opt: { choice: `switch ${i + 1}`, switchTo: mon.species.id, score: 0 },
          kind: "switch",
          prio: 7,
          dmg: [],
          allyRaw: 0,
          recoil: 0,
          pAct: 0,
          base,
        });
      });
    }
    if (out.length === 0)
      out.push({
        opt: { choice: "move 1", score: 0 },
        kind: "status",
        prio: 0,
        dmg: [],
        allyRaw: 0,
        recoil: 0,
        pAct: 0,
        base: 0,
      });
    return out;
  });
  return { acts, foes, foeActive };
}

function selfLossOf(
  foes: FoeModel[],
  m: PsPokemon,
  pos: number,
  b: PsBattle,
  tags: EngineTags,
  params: PolicyParams,
  koBonus: number,
): number {
  const x = incoming(foes, m, pos, 0, b, tags, params, false);
  return Math.min(x.exp, m.hp) / m.maxhp + koBonus * x.pKO;
}

/** Score a joint action (one Act per slot). */
function jointScore(plan: Plan, side: PsSide, sel: Act[], params: PolicyParams): number {
  const koBonus = p(params, "koBonus");
  const denialW = p(params, "denialWeight");
  let score = 0;
  plan.foeActive.forEach((f, fi) => {
    if (!alive(f)) return;
    const fm = plan.foes.find((x) => x.pos === fi);
    const pProt = fm?.pProtect ?? 0;
    // the foe's most likely action priority (for "do I hit it before it moves?")
    const top = fm?.options.reduce((a, o) => (o.q > a.q ? o : a), fm.options[0]!);
    const foePrio = top?.atk.prio ?? 0;
    let D = 0;
    let Dfirst = 0;
    sel.forEach((a, s) => {
      const d = a.dmg[fi];
      if (d === undefined || a.kind !== "attack") return;
      const me = side.active[s]!;
      D += a.pAct * d;
      Dfirst += a.pAct * d * actsFirst(me, a.prio, f, foePrio);
    });
    if (D <= 0) return;
    const live = 1 - pProt;
    score += live * (Math.min(D, f.hp) / f.maxhp + koBonus * koChance(D, f.hp));
    score += live * denialW * koChance(Dfirst, f.hp) * (fm?.threat ?? 0);
  });
  sel.forEach((a, s) => {
    score += a.base;
    const me = side.active[s];
    if (!alive(me) || a.kind !== "attack") return;
    if (a.allyRaw > 0) {
      const other = sel[1 - s];
      const ally = side.active[1 - s];
      if (alive(ally) && other?.kind !== "protect" && other?.kind !== "switch")
        score -= p(params, "allyHitPenalty") * hitValue(ally, a.allyRaw, koBonus);
    }
    if (a.recoil > 0) {
      const dealt = a.dmg.reduce<number>((x, d) => x + (d ?? 0), 0) * a.pAct;
      score -= p(params, "recoilWeight") * Math.min(1, (dealt * a.recoil) / me.maxhp);
    }
  });
  return score;
}

const conflicts = (sel: Act[]) => {
  const sw = sel.filter((a) => a.kind === "switch").map((a) => a.opt.choice);
  return new Set(sw).size !== sw.length;
};

function dedupeMega(choices: string[]): string[] {
  let used = false;
  return choices.map((c) => {
    if (!c.endsWith(" mega")) return c;
    if (used) return c.slice(0, -5);
    used = true;
    return c;
  });
}

/** Every joint action of a side, scored and sorted (best first). */
export function plannedJoints(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
): JointOption[] {
  const req = side.activeRequest;
  if (!req?.active) return [];
  const plan = buildPlan(b, side, req, tags, params);
  let joint: Act[][] = [[]];
  for (const opts of plan.acts) joint = joint.flatMap((j) => opts.map((o) => [...j, o]));
  return joint
    .filter((sel) => !conflicts(sel))
    .map((sel) => {
      const score = jointScore(plan, side, sel, params);
      return {
        choice: dedupeMega(sel.map((a) => a.opt.choice)).join(", "),
        slots: sel.map((a) => ({ ...a.opt, score })),
        score,
      };
    })
    .sort((x, y) => y.score - x.score || x.choice.localeCompare(y.choice));
}

/** Forced switch: send in the bench Pokémon with the best matchup against the foes on the field. */
export function plannedSwitch(
  b: PsBattle,
  side: PsSide,
  req: PsRequest,
  tags: EngineTags,
  params: PolicyParams,
): string {
  const koBonus = p(params, "koBonus");
  const foeActive = side.foe.active;
  const foes = modelFoes(b, foeActive, side.active, tags, params);
  const used = new Set<number>();
  return (req.forceSwitch ?? [])
    .map((must, slot) => {
      if (!must) return "pass";
      let best = -1;
      let bestScore = -Infinity;
      req.side.pokemon.forEach((pk, i) => {
        if (pk.active || used.has(i) || pk.condition.endsWith(" fnt")) return;
        const mon = side.pokemon[i];
        if (!alive(mon)) return;
        const inX = incoming(foes, mon, slot, 0, b, tags, params, true);
        const taken = Math.min(inX.exp, mon.hp) / mon.maxhp + koBonus * inX.pKO;
        let off = 0;
        for (const a of attacksOf(b, mon, foeActive, null, usableMoves(mon), tags, params)) {
          let v = 0;
          a.dmg.forEach((d, fi) => {
            const t = foeActive[fi];
            if (d !== undefined && alive(t)) v += hitValue(t, d, koBonus);
          });
          off = Math.max(off, v);
        }
        const s = off - taken + (mon.hp / mon.maxhp) * 0.1;
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      if (best < 0) return "pass";
      used.add(best);
      return `switch ${best + 1}`;
    })
    .join(", ");
}

function softmax(scores: number[], T: number): number[] {
  const max = Math.max(...scores);
  const w = scores.map((s) => Math.exp((s - max) / Math.max(1e-6, T)));
  const tot = w.reduce((a, x) => a + x, 0);
  return w.map((x) => x / tot);
}

/** Sample a joint action (softmax over joint scores); records per-slot marginals in `trace`. */
export function plannedChoice(
  b: PsBattle,
  side: PsSide,
  tags: EngineTags,
  params: PolicyParams,
  T: number,
  rng: Rng,
  trace?: DecisionTrace[],
): string {
  const joints = plannedJoints(b, side, tags, params);
  if (joints.length === 0) return "default";
  const probs = softmax(
    joints.map((j) => j.score),
    T,
  );
  let r = rng.next();
  let pick = joints.length - 1;
  for (let i = 0; i < joints.length; i++) {
    r -= probs[i]!;
    if (r <= 0) {
      pick = i;
      break;
    }
  }
  const chosen = joints[pick]!;
  if (trace) {
    chosen.slots.forEach((slotOpt, slot) => {
      const mon = side.active[slot];
      if (!alive(mon)) return;
      const marg = new Map<string, { option: SlotOption; prob: number }>();
      joints.forEach((j, k) => {
        const o = j.slots[slot]!;
        const e = marg.get(o.choice);
        if (e) {
          e.prob += probs[k]!;
          e.option.score = Math.max(e.option.score, j.score);
        } else marg.set(o.choice, { option: { ...o, score: j.score }, prob: probs[k]! });
      });
      const options = [...marg.values()].sort((x, y) => y.prob - x.prob);
      trace.push({
        turn: b.turn,
        side: side.id === "p1" ? 0 : 1,
        species: mon.species.id,
        hpPct: Math.round((mon.hp / mon.maxhp) * 100),
        options,
        chosen: options.findIndex((o) => o.option.choice === slotOpt.choice),
      });
    });
  }
  return chosen.choice;
}
