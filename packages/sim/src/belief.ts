// What a player can know, and possible worlds consistent with it (ADR-0012).
//
// A decision must not use information its maker could not have at that time. From one side's
// point of view the opponent's team preview (6 species), the Pokémon that have appeared, the moves
// they used, items and abilities that were shown, HP percentages and everything on the field are
// public. Unrevealed moves, items, abilities, stat spreads and the identity of unseen back-line
// Pokémon are not. A "world" is the real state with exactly those hidden parts replaced by a
// sample from a prior (usage statistics), constrained by what was observed (e.g. move order
// reveals who is faster).
import type { PokemonSet, StatsTable, UsageSnapshot } from "@ca/schema";
import { calcStat, type NatureName } from "@ca/calc";
import type { Rng } from "./rng.js";
import type { SimContext } from "./runner.js";
import { Battle, toShowdownSet, type PsBattle, type ShowdownSet } from "./showdown.js";
import type { Snapshot } from "./replay.js";

const toId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

interface Share {
  id: string;
  share: number;
}
export interface SpeciesPrior {
  moves: Share[];
  items: Share[];
  abilities: Share[];
  spreads: { nature: string; sp: StatsTable; share: number }[];
  /** relative usage of the species (for guessing unseen back-line Pokémon) */
  usage: number;
}
/** Prior over sets per species (from a usage snapshot). */
export type Prior = (species: string) => SpeciesPrior | undefined;

/** Merge every entry of a species (e.g. Mega and non-Mega variants) weighted by usage. */
export function priorFromUsage(u: UsageSnapshot): Prior {
  const by = new Map<string, SpeciesPrior>();
  const groups = new Map<string, UsageSnapshot["entries"]>();
  for (const e of u.entries) {
    if (!e.distributions) continue;
    groups.set(e.species, [...(groups.get(e.species) ?? []), e]);
  }
  for (const [sp, es] of groups) {
    const total = es.reduce((a, e) => a + e.usage, 0) || 1;
    const merge = <T extends { share: number }>(
      pick: (d: NonNullable<(typeof es)[number]["distributions"]>) => T[],
      key: (x: T) => string,
    ): T[] => {
      const m = new Map<string, T>();
      for (const e of es)
        for (const x of pick(e.distributions!)) {
          const k = key(x);
          const prev = m.get(k);
          const w = (x.share * e.usage) / total;
          m.set(k, prev ? { ...prev, share: prev.share + w } : { ...x, share: w });
        }
      return [...m.values()].sort((a, b) => b.share - a.share);
    };
    by.set(sp, {
      moves: merge(
        (d) => d.moves,
        (x) => x.id,
      ),
      items: merge(
        (d) => d.items,
        (x) => x.id,
      ),
      abilities: merge(
        (d) => d.abilities,
        (x) => x.id,
      ),
      spreads: merge(
        (d) => d.spreads,
        (x) => `${x.nature}:${Object.values(x.sp).join(",")}`,
      ),
      usage: total,
    });
  }
  return (species) => by.get(species);
}

/** What `viewer` knows about one opposing Pokémon (by its index in side.pokemon). */
export interface FoeKnowledge {
  index: number;
  /** null = not seen yet (could be any unseen species from team preview) */
  species: string | null;
  moves: string[];
  item: string | null;
  /** true when the item is known to be gone (consumed, knocked off) */
  itemGone: boolean;
  ability: string | null;
  mega: boolean;
}

/** Observed move order: `first` moved before `second` with equal priority in a neutral turn. */
export interface SpeedFact {
  /** foe Pokémon index (side.pokemon) */
  foe: number;
  /** viewer's Pokémon index */
  mine: number;
  /** true = the foe moved first */
  foeFirst: boolean;
}

export interface Observation {
  viewer: 0 | 1;
  /** opposing species from team preview */
  preview: string[];
  foes: FoeKnowledge[];
  speed: SpeedFact[];
}

interface MonJson {
  set: ShowdownSet;
  moveSlots: { id: string; used?: boolean; pp: number; maxpp: number }[];
  previouslySwitchedIn?: number;
  isActive?: boolean;
  fainted?: boolean;
  hp: number;
  maxhp: number;
  baseMaxhp: number;
  storedStats: Record<string, number>;
  baseStoredStats: Record<string, number>;
  item: string;
  ability: string;
  baseAbility: string;
  itemState: unknown;
  abilityState: unknown;
  species: string;
  baseSpecies: string;
  position: number;
  speed: number;
  [k: string]: unknown;
}
interface StateJson {
  sides: { id: string; pokemon: MonJson[] }[];
  log: string[];
  formatid: string;
  [k: string]: unknown;
}

const IDENT = /^p([12])[a-z]?: (.+)$/;

/** Read what `viewer` can know from the public battle log and the move slots' `used` flags. */
export function observe(b: PsBattle, viewer: 0 | 1): Observation {
  const foeSide = b.sides[1 - viewer]!;
  const mySide = b.sides[viewer]!;
  const fid = foeSide.id;
  const preview: string[] = [];
  const idx = (name: string, side = foeSide) => side.pokemon.findIndex((p) => p.name === name);
  const foes: FoeKnowledge[] = foeSide.pokemon.map((p, i) => {
    const any = p as unknown as {
      previouslySwitchedIn: number;
      isActive: boolean;
      moveSlots: { id: string; used?: boolean }[];
      set: { species: string };
    };
    const seen = any.previouslySwitchedIn > 0 || any.isActive || p.fainted;
    return {
      index: i,
      species: seen ? toId(any.set.species) : null,
      moves: seen ? any.moveSlots.filter((m) => m.used).map((m) => m.id) : [],
      item: null,
      itemGone: false,
      ability: null,
      mega: false,
    };
  });
  const speed: SpeedFact[] = [];
  // per-turn bookkeeping for move-order facts
  let neutral = true; // no weather/terrain/Trick Room/Tailwind at the start of this turn
  const fieldOn = new Set<string>();
  const tainted = new Set<string>(); // "side:index" whose speed changed (boost, paralysis, mega…)
  let order: { side: 0 | 1; index: number; priority: number }[] = [];
  const flush = () => {
    if (neutral)
      for (let i = 0; i + 1 < order.length; i++) {
        const x = order[i]!;
        const y = order[i + 1]!;
        if (x.side === y.side || x.priority !== y.priority) continue;
        const foe = x.side === viewer ? y : x;
        const mine = x.side === viewer ? x : y;
        if (tainted.has(`${foe.side}:${foe.index}`) || tainted.has(`${mine.side}:${mine.index}`))
          continue;
        speed.push({ foe: foe.index, mine: mine.index, foeFirst: x === foe });
      }
    order = [];
    neutral = fieldOn.size === 0;
  };
  let skip = false;
  for (const line of b.log) {
    if (line.startsWith("|split|")) {
      skip = true; // the next line is the private copy; the public one follows
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    const parts = line.split("|");
    const kind = parts[1] ?? "";
    const who = (s: string | undefined) => {
      const m = IDENT.exec(s ?? "");
      if (!m) return undefined;
      const side = (Number(m[1]) - 1) as 0 | 1;
      return { side, index: idx(m[2]!, b.sides[side]) };
    };
    const subject = who(parts[2]);
    const ofPart = parts.find((x) => x.startsWith("[of] "));
    const of = ofPart ? who(ofPart.slice(5)) : undefined;
    const fromPart = parts.find((x) => x.startsWith("[from] "));
    const foeMon = (w: { side: 0 | 1; index: number } | undefined) =>
      w && w.side !== viewer && w.index >= 0 ? foes[w.index] : undefined;
    if (kind === "poke" && parts[2] === fid) preview.push(toId((parts[3] ?? "").split(",")[0]!));
    if (kind === "turn") flush();
    // only attacks chosen this turn (status moves can get Prankster priority; called moves skip)
    if (kind === "move" && subject && subject.index >= 0 && !fromPart) {
      const mv = b.dex.moves.get(parts[3] ?? "");
      if (mv.category !== "Status")
        order.push({ side: subject.side, index: subject.index, priority: mv.priority });
    }
    if (kind === "-fieldstart" || kind === "-weather" || kind === "-sidestart") {
      const what = toId(parts[kind === "-sidestart" ? 3 : 2] ?? "");
      if (!(kind === "-weather" && parts.includes("[upkeep]"))) neutral = false; // changed mid-turn
      if (kind === "-weather" && what === "none") fieldOn.delete("weather");
      else if (kind === "-weather") fieldOn.add("weather");
      else if (kind === "-sidestart" && !what.includes("tailwind")) {
        /* screens etc. do not change speed */
      } else fieldOn.add(what);
    }
    if (kind === "-fieldend" || kind === "-sideend") {
      fieldOn.delete(toId(parts[kind === "-sideend" ? 3 : 2] ?? ""));
      neutral = false;
    }
    if (
      ((kind === "-boost" || kind === "-unboost") && parts[3] === "spe") ||
      (kind === "-status" && parts[3] === "par") ||
      kind === "-mega" ||
      kind === "detailschange"
    )
      if (subject) tainted.add(`${subject.side}:${subject.index}`);
    // items
    if ((kind === "-item" || kind === "-enditem") && foeMon(subject)) {
      const f = foeMon(subject)!;
      f.item = toId(parts[3] ?? "");
      if (kind === "-enditem") f.itemGone = true;
    }
    if (kind === "-mega" && foeMon(subject)) {
      const f = foeMon(subject)!;
      f.mega = true;
      if (parts[4]) f.item = toId(parts[4]);
    }
    if (fromPart?.startsWith("[from] item: ")) {
      const f = foeMon(of ?? subject);
      if (f) f.item = toId(fromPart.slice(13));
    }
    // abilities
    if (kind === "-ability" && foeMon(subject)) foeMon(subject)!.ability = toId(parts[3] ?? "");
    if (fromPart?.startsWith("[from] ability: ")) {
      const f = foeMon(of ?? subject);
      if (f) f.ability = toId(fromPart.slice(16));
    }
  }
  void mySide;
  return { viewer, preview, foes, speed };
}

function pick<T>(xs: T[], weight: (x: T) => number, rng: Rng): T | undefined {
  const total = xs.reduce((a, x) => a + Math.max(0, weight(x)), 0);
  if (total <= 0) return xs[0];
  let r = rng.next() * total;
  for (const x of xs) {
    r -= Math.max(0, weight(x));
    if (r <= 0) return x;
  }
  return xs.at(-1);
}

const CHOICE_ITEMS = new Set(["choicescarf", "choiceband", "choicespecs"]);

/** Speed stat a world gives one Pokémon (scarf included; boosts/field are excluded by design). */
function speedOf(
  ctx: SimContext,
  b: PsBattle,
  species: string,
  nature: string,
  sp: StatsTable,
  item: string,
): number {
  const base = b.dex.species.get(species).baseStats["spe"] ?? 0;
  const s = calcStat(ctx.spec, "spe", base, sp.spe ?? 0, nature as NatureName);
  return item === "choicescarf" ? Math.floor(s * 1.5) : s;
}

/** A sampled hidden set for one foe Pokémon. */
interface Sampled {
  set: PokemonSet;
  /** which parts were sampled (the rest came from observation) */
  hidden: { moves: string[]; item: boolean; ability: boolean; stats: boolean; species: boolean };
}

/**
 * One possible world from `viewer`'s point of view: the real state with the opponent's hidden
 * information replaced by a sample. Returns the real state unchanged when there is nothing hidden
 * or no prior for a species (then that Pokémon keeps its real set: documented limitation).
 */
export function determinize(
  ctx: SimContext,
  state: Snapshot,
  b: PsBattle,
  obs: Observation,
  prior: Prior,
  rng: Rng,
): Snapshot {
  const j = JSON.parse(state) as StateJson;
  const foeSide = j.sides[1 - obs.viewer]!;
  const mySide = j.sides[obs.viewer]!;
  const myMons = b.sides[obs.viewer]!.pokemon;
  const usedSpecies = new Set(obs.foes.flatMap((f) => (f.species ? [f.species] : [])));
  const usedItems = new Set(obs.foes.flatMap((f) => (f.item ? [f.item] : [])));
  const sampled: (Sampled | null)[] = [];
  for (const f of obs.foes) {
    // species
    let species = f.species;
    let speciesHidden = false;
    if (!species) {
      const pool = obs.preview.filter((s) => !usedSpecies.has(s));
      species = pick(pool, (s) => prior(s)?.usage ?? 0.01, rng) ?? null;
      speciesHidden = true;
      if (!species) {
        sampled.push(null);
        continue;
      }
      usedSpecies.add(species);
    }
    const pr = prior(species);
    if (!pr || f.mega) {
      // no prior, or a Mega Evolved Pokémon (its form's stats cannot be resampled here)
      sampled.push(null);
      continue;
    }
    // item (Item Clause: no duplicates on a team)
    let item = f.item;
    const itemHidden = !item;
    if (!item) {
      // a Pokémon that was on the field without Mega Evolving does not hold its Mega Stone
      const wasActive =
        (
          b.sides[1 - obs.viewer]!.pokemon[f.index] as unknown as
            { activeTurns?: number } | undefined
        )?.activeTurns ?? 0;
      const opts = pr.items.filter(
        (x) => !usedItems.has(x.id) && !(wasActive > 0 && b.dex.items.get(x.id).megaStone),
      );
      item = pick(opts, (x) => x.share, rng)?.id ?? "";
    }
    if (item) usedItems.add(item);
    // ability
    const ability = f.ability ?? pick(pr.abilities, (x) => x.share, rng)?.id ?? "";
    // moves: revealed + sampled without replacement
    const moves = [...f.moves];
    const pool = pr.moves.filter(
      (m) =>
        !moves.includes(m.id) &&
        b.dex.moves.get(m.id).exists !== false &&
        !(CHOICE_ITEMS.has(item ?? "") && b.dex.moves.get(m.id).category === "Status"),
    );
    while (moves.length < 4 && pool.length) {
      const m = pick(pool, (x) => x.share, rng)!;
      moves.push(m.id);
      pool.splice(pool.indexOf(m), 1);
    }
    // spread, filtered by observed move order when possible
    const facts = obs.speed.filter((s) => s.foe === f.index);
    const ok = (sp: { nature: string; sp: StatsTable }) =>
      facts.every((s) => {
        const mine = myMons[s.mine];
        if (!mine) return true;
        const my =
          (mine as unknown as { storedStats: Record<string, number> }).storedStats["spe"] ?? 0;
        const mySpe = mine.item === "choicescarf" ? Math.floor(my * 1.5) : my;
        const foeSpe = speedOf(ctx, b, species!, sp.nature, sp.sp, item ?? "");
        return s.foeFirst ? foeSpe >= mySpe : foeSpe <= mySpe;
      });
    const consistent = pr.spreads.filter(ok);
    const spread = pick(consistent.length ? consistent : pr.spreads, (x) => x.share, rng);
    if (!spread || moves.length === 0) {
      sampled.push(null);
      continue;
    }
    sampled.push({
      set: {
        species,
        ...(item ? { item } : {}),
        ability,
        nature: spread.nature as NatureName,
        sp: spread.sp,
        moves,
        assumed: [],
        confidence: {},
      } as PokemonSet,
      hidden: {
        moves: moves.filter((m) => !f.moves.includes(m)),
        item: itemHidden,
        ability: !f.ability,
        stats: true,
        species: speciesHidden,
      },
    });
  }
  if (sampled.every((x) => x === null)) return state;

  // A fresh battle with the sampled sets in the same team order gives Showdown's own objects
  // (stats, move slots, item/ability state) for the hidden parts.
  const lvl = ctx.pack.rules.level;
  const iv = ctx.spec.iv.value;
  const foeTeam: ShowdownSet[] = foeSide.pokemon.map((p, i) =>
    sampled[i] ? toShowdownSet(sampled[i]!.set, iv, lvl) : p.set,
  );
  const fresh = new Battle({ formatid: ctx.format, seed: [1, 2, 3, 4] });
  const ids = obs.viewer === 0 ? (["p1", "p2"] as const) : (["p2", "p1"] as const);
  fresh.setPlayer(ids[0], { name: "me", team: mySide.pokemon.map((p) => p.set) });
  fresh.setPlayer(ids[1], { name: "foe", team: foeTeam });
  const order = (n: number) => `team ${Array.from({ length: n }, (_, i) => i + 1).join("")}`;
  fresh.choose("p1", order((obs.viewer === 0 ? mySide : foeSide).pokemon.length));
  fresh.choose("p2", order((obs.viewer === 0 ? foeSide : mySide).pokemon.length));
  const fj = JSON.parse(
    JSON.stringify((fresh as unknown as { toJSON(): unknown }).toJSON()),
  ) as StateJson;
  const freshFoe = fj.sides[1 - obs.viewer]!.pokemon;

  foeSide.pokemon.forEach((p, i) => {
    const s = sampled[i];
    const fp = freshFoe[i];
    if (!s || !fp) return;
    if (s.hidden.species) {
      // never on the field: replace the whole Pokémon, keeping its slot
      foeSide.pokemon[i] = { ...fp, position: p.position };
      return;
    }
    const frac = p.maxhp ? p.hp / p.maxhp : 0;
    const used = new Map(p.moveSlots.map((m) => [m.id, m]));
    p.moveSlots = fp.moveSlots.map((m) => used.get(m.id) ?? m);
    if (s.hidden.item && !obs.foes[i]!.itemGone) {
      p.item = fp.item;
      p.itemState = fp.itemState;
    }
    if (s.hidden.ability) {
      p.ability = fp.ability;
      p.baseAbility = fp.baseAbility;
      p.abilityState = fp.abilityState;
    }
    p.storedStats = fp.storedStats;
    p.baseStoredStats = fp.baseStoredStats;
    p.maxhp = fp.maxhp;
    p.baseMaxhp = fp.baseMaxhp;
    p.hp = p.hp <= 0 ? 0 : Math.max(1, Math.round(frac * fp.maxhp));
    p.speed = fp.speed;
    p.canMegaEvo = fp.canMegaEvo;
    p.set = { ...fp.set, name: p.set.name };
  });
  return JSON.stringify(j);
}
