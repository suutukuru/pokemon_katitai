import type { PokemonSet } from "@ca/schema";
import type { DecisionTrace } from "./policy.js";
import { playOut, startBattle, type BattleResult, type Config, type SimContext } from "./runner.js";
import type { PsBattle } from "./showdown.js";

/** Structured, language-neutral battle events parsed from the Showdown protocol log. */
export type BattleEvent =
  | { t: "switch"; side: 0 | 1; who: string; hp: number; slot: number }
  | {
      t: "move";
      side: 0 | 1;
      who: string;
      move: string;
      target?: { side: 0 | 1; who: string };
      spread: boolean;
    }
  | { t: "damage" | "heal"; side: 0 | 1; who: string; hp: number; from?: string }
  | { t: "faint"; side: 0 | 1; who: string }
  | { t: "crit" | "super" | "resisted" | "immune"; side: 0 | 1; who: string }
  | { t: "miss"; side: 0 | 1; who: string }
  | { t: "fail"; side: 0 | 1; who: string }
  | { t: "protected"; side: 0 | 1; who: string }
  | { t: "mega"; side: 0 | 1; who: string }
  | { t: "boost"; side: 0 | 1; who: string; stat: string; n: number }
  | { t: "status"; side: 0 | 1; who: string; status: string }
  | { t: "cant"; side: 0 | 1; who: string; reason: string }
  | { t: "weather"; weather: string; upkeep: boolean }
  | { t: "sidestart" | "sideend"; side: 0 | 1; cond: string }
  | { t: "fieldstart" | "fieldend"; cond: string };

export interface TurnLog {
  turn: number;
  decisions: DecisionTrace[];
  events: BattleEvent[];
  /** HP% of every Pokémon brought, after this turn. */
  hp: { side: 0 | 1; who: string; hp: number; active: boolean }[];
}

export interface BattleLog {
  seed: number;
  result: BattleResult;
  brought: [string[], string[]];
  turns: TurnLog[];
}

const idOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Parse "p2a: Pelipper" → side and our species ID (by the Pokémon's name on that side). */
function who(b: PsBattle, ident: string): { side: 0 | 1; who: string } | undefined {
  const m = /^p([12])[a-z]?: (.+)$/.exec(ident);
  if (!m) return undefined;
  const side = (Number(m[1]) - 1) as 0 | 1;
  const mon = b.sides[side].pokemon.find((p) => p.name === m[2]);
  const set = (mon as unknown as { set?: { species: string } } | undefined)?.set;
  return { side, who: set ? idOf(set.species) : idOf(m[2]!) };
}

const hpOf = (cond: string) => {
  if (cond.startsWith("0")) return 0;
  const [a, b] = (cond.split(" ")[0] ?? "").split("/").map((x) => parseFloat(x)); // "20/100y" happens
  return a !== undefined && b ? Math.round((a / b) * 100) : 0;
};

/** Convert the battle's protocol log into per-turn events (public lines only), from line `from`. */
export function parseLog(b: PsBattle, from = 0): Map<number, BattleEvent[]> {
  const out = new Map<number, BattleEvent[]>();
  let turn = 0;
  if (from > 0)
    for (let i = from - 1; i >= 0; i--) {
      const m = /^\|turn\|(\d+)/.exec(b.log[i] ?? "");
      if (m) {
        turn = Number(m[1]);
        break;
      }
    }
  const push = (e: BattleEvent) => {
    const xs = out.get(turn) ?? [];
    xs.push(e);
    out.set(turn, xs);
  };
  let skip = false;
  for (const line of b.log.slice(from)) {
    if (line.startsWith("|split|")) {
      skip = true; // next line is the private copy; the public one follows it
      continue;
    }
    if (skip) {
      skip = false;
      continue;
    }
    const [, kind, a = "", c = "", d = "", ...rest] = line.split("|");
    const w = who(b, a);
    switch (kind) {
      case "turn":
        turn = Number(a);
        break;
      case "switch":
      case "drag":
        if (w) push({ t: "switch", ...w, hp: hpOf(d), slot: /^p[12]b/.test(a) ? 1 : 0 });
        break;
      case "move": {
        if (!w) break;
        const tg = who(b, d);
        push({
          t: "move",
          ...w,
          move: idOf(c),
          ...(tg ? { target: tg } : {}),
          spread: rest.some((x) => x.startsWith("[spread]")) || line.includes("[spread]"),
        });
        break;
      }
      case "-damage":
      case "-heal":
        if (w)
          push({
            t: kind === "-damage" ? "damage" : "heal",
            ...w,
            hp: hpOf(c),
            ...(d.startsWith("[from]")
              ? { from: idOf(d.replace("[from]", "").replace(/^ ?(item|ability):/, "")) }
              : {}),
          });
        break;
      case "faint":
        if (w) push({ t: "faint", ...w });
        break;
      case "-crit":
      case "-supereffective":
      case "-resisted":
      case "-immune":
        if (w)
          push({
            t: (
              {
                "-crit": "crit",
                "-supereffective": "super",
                "-resisted": "resisted",
                "-immune": "immune",
              } as const
            )[kind],
            ...w,
          });
        break;
      case "-miss": {
        const tg = who(b, c);
        if (tg) push({ t: "miss", ...tg });
        else if (w) push({ t: "miss", ...w });
        break;
      }
      case "-fail":
        if (w) push({ t: "fail", ...w });
        break;
      case "-activate":
        if (
          w &&
          /Protect|Detect|Spiky Shield|King's Shield|Burning Bulwark|Silk Trap|Baneful Bunker/.test(
            c,
          )
        )
          push({ t: "protected", ...w });
        break;
      case "-mega":
        if (w) push({ t: "mega", ...w });
        break;
      case "-boost":
      case "-unboost":
        if (w)
          push({ t: "boost", ...w, stat: c, n: (kind === "-boost" ? 1 : -1) * Number(d || 1) });
        break;
      case "-status":
        if (w) push({ t: "status", ...w, status: c });
        break;
      case "cant":
        if (w) push({ t: "cant", ...w, reason: idOf(c) });
        break;
      case "-weather":
        if (a !== "none" || !line.includes("[upkeep]"))
          push({ t: "weather", weather: a, upkeep: line.includes("[upkeep]") });
        break;
      case "-sidestart":
      case "-sideend": {
        const side = (a.startsWith("p2") ? 1 : 0) as 0 | 1;
        push({
          t: kind === "-sidestart" ? "sidestart" : "sideend",
          side,
          cond: idOf(c.replace("move: ", "")),
        });
        break;
      }
      case "-fieldstart":
      case "-fieldend":
        push({
          t: kind === "-fieldstart" ? "fieldstart" : "fieldend",
          cond: idOf(a.replace("move: ", "")),
        });
        break;
    }
  }
  return out;
}

/** Play one battle with full tracing (decisions with scores/probabilities + events + HP per turn). */
export function traceBattle(
  ctx: SimContext,
  a: readonly PokemonSet[],
  b: readonly PokemonSet[],
  ca: Config,
  cb: Config,
  seed: number,
): BattleLog {
  const battle = startBattle(ctx, a, b, ca, cb, seed);
  const decisions: DecisionTrace[] = [];
  const result = playOut(ctx, battle, seed, decisions);
  const events = parseLog(battle);
  const hp = new Map<string, { side: 0 | 1; who: string; hp: number; active: boolean }>();
  const occupant: [string[], string[]] = [[], []];
  const turns: TurnLog[] = [];
  const maxTurn = Math.max(battle.turn, ...events.keys());
  for (let t = 0; t <= maxTurn; t++) {
    const ev = events.get(t) ?? [];
    for (const e of ev) {
      if (e.t === "switch") {
        occupant[e.side][e.slot] = e.who;
        hp.set(`${e.side}:${e.who}`, { side: e.side, who: e.who, hp: e.hp, active: true });
      }
      if (e.t === "damage" || e.t === "heal") {
        const v = hp.get(`${e.side}:${e.who}`);
        if (v) v.hp = e.hp;
      }
      if (e.t === "faint") {
        const v = hp.get(`${e.side}:${e.who}`);
        if (v) v.hp = 0;
        const i = occupant[e.side].indexOf(e.who);
        if (i >= 0) occupant[e.side][i] = "";
      }
    }
    for (const v of hp.values()) v.active = occupant[v.side].includes(v.who) && v.hp > 0;
    const d = decisions.filter((x) => x.turn === t);
    if (ev.length || d.length)
      turns.push({
        turn: t,
        decisions: d,
        events: ev,
        hp: [...hp.values()].map((v) => ({ ...v })),
      });
  }
  return {
    seed,
    result,
    brought: [ca.map((i) => a[i]!.species), cb.map((i) => b[i]!.species)],
    turns,
  };
}
