import { toID, type RecordMonState, type RecordSlotAction, type RecordTurn } from "@ca/schema";

/** What a Showdown battle log gives us for a BattleRecord (teams come from the user). */
export interface ParsedReplayLog {
  brought: [string[], string[]];
  turns: RecordTurn[];
  winner: 0 | 1 | null;
  issues: string[];
}

interface Mon {
  species: string;
  hpPct: number;
  status: RecordMonState["status"];
  boosts: Record<string, number>;
}

const STATUSES = new Set(["brn", "par", "slp", "frz", "psn", "tox"]);

/** "p2a: Pelipper" → side, slot, name. Position-less idents ("p2: Pelipper") have slot -1. */
function ident(s: string | undefined): { side: 0 | 1; slot: number; name: string } | undefined {
  const m = /^p([12])([ab]?): (.+)$/.exec(s ?? "");
  if (!m) return undefined;
  return {
    side: (Number(m[1]) - 1) as 0 | 1,
    slot: m[2] ? m[2].charCodeAt(0) - 97 : -1,
    name: m[3]!,
  };
}

/** "85/100 par" → 85 (percent), "par"; "0 fnt" → 0. */
function condition(s: string | undefined): { hpPct: number; status: Mon["status"] } {
  const [hp = "", st] = (s ?? "").split(" ");
  if (hp.startsWith("0")) return { hpPct: 0, status: null };
  const [a, b] = hp.split("/").map((x) => parseFloat(x));
  const hpPct = a !== undefined && b ? Math.max(0, Math.min(100, (a / b) * 100)) : 100;
  return { hpPct, status: st && STATUSES.has(st) ? (st as Mon["status"]) : null };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Convert a Showdown battle log (the text of a saved replay, protocol lines starting with `|`)
 * into turns: the observed state at each turn start, each slot's action, and replacements after
 * faints. Moves called by other effects (`[from]`) are ignored. A slot that did not act
 * (flinch, sleep, fainted first) is `unknown`.
 */
export function parseShowdownReplayLog(log: string): ParsedReplayLog {
  const issues: string[] = [];
  const players = new Map<string, 0 | 1>();
  const mons = new Map<string, Mon>(); // key: side + name
  const active: [(string | null)[], (string | null)[]] = [[], []];
  const brought: [string[], string[]] = [[], []];
  const turns: RecordTurn[] = [];
  let winner: 0 | 1 | null = null;
  const st: { cur: RecordTurn | null } = { cur: null };
  let actions: [(RecordSlotAction | null)[], (RecordSlotAction | null)[]] = [[], []];
  let megaPending: [boolean[], boolean[]] = [[], []];
  let afterUpkeep = false;
  /** Active slots at the start of the current turn (null = empty), for slot → state index. */
  let turnActive: [(string | null)[], (string | null)[]] = [[], []];
  const key = (side: 0 | 1, name: string) => `${side}:${name}`;

  const finishTurn = () => {
    if (!st.cur) return;
    ([0, 1] as const).forEach((s) => {
      st.cur!.actions[s] = st.cur!.state![s].map(
        (_, i) => actions[s][i] ?? { unknown: true as const },
      );
    });
    turns.push(st.cur);
    st.cur = null;
  };
  const startTurn = (n: number) => {
    finishTurn();
    const state = ([0, 1] as const).map((s) =>
      active[s]
        .filter((n2): n2 is string => n2 !== null)
        .map((name) => {
          const m = mons.get(key(s, name))!;
          const boosts = Object.fromEntries(Object.entries(m.boosts).filter(([, v]) => v !== 0));
          return {
            species: m.species,
            hpPct: round1(m.hpPct),
            ...(m.status ? { status: m.status } : {}),
            ...(Object.keys(boosts).length ? { boosts } : {}),
          };
        }),
    ) as [RecordMonState[], RecordMonState[]];
    st.cur = { turn: n, state, actions: [[], []], replacements: [[], []] };
    actions = [[], []];
    megaPending = [[], []];
    afterUpkeep = false;
    turnActive = [[...active[0]], [...active[1]]];
  };
  /** Active slot index within the turn's state list (fainted slots are skipped there). */
  const stateIndex = (side: 0 | 1, slot: number) => {
    let k = 0;
    for (let i = 0; i < slot; i++) if (turnActive[side][i] != null) k++;
    return k;
  };

  let skipNext = false;
  for (const raw of log.split(/\r?\n/)) {
    // Omniscient logs: `|split|p1` is followed by the exact (secret) line, then the public one.
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (raw.startsWith("|split|")) {
      skipNext = true;
      continue;
    }
    const parts = raw.split("|");
    if (parts[0] !== "" || parts.length < 2) continue;
    const [, tag, a1, a2, a3, ...rest] = parts;
    switch (tag) {
      case "player":
        if (a1 === "p1" || a1 === "p2") players.set(a2 ?? "", a1 === "p1" ? 0 : 1);
        break;
      case "switch":
      case "drag": {
        const id = ident(a1);
        if (!id || id.slot < 0) break;
        const species = toID((a2 ?? "").split(",")[0] ?? "");
        const k = key(id.side, id.name);
        const c = condition(a3);
        const prev = mons.get(k);
        mons.set(k, {
          species: prev?.species ?? species,
          hpPct: c.hpPct,
          status: c.status,
          boosts: {},
        });
        if (!brought[id.side].includes(prev?.species ?? species))
          brought[id.side].push(prev?.species ?? species);
        if (st.cur && tag === "switch") {
          const si = stateIndex(id.side, id.slot);
          if (afterUpkeep) st.cur.replacements![id.side].push(prev?.species ?? species);
          else if (active[id.side][id.slot] !== null && !actions[id.side][si])
            actions[id.side][si] = { switch: prev?.species ?? species };
        }
        active[id.side][id.slot] = id.name;
        break;
      }
      case "move": {
        const id = ident(a1);
        if (!id || !st.cur || id.slot < 0) break;
        const extra = [a3, ...rest].filter((x): x is string => x !== undefined);
        // moves called by other effects are not choices; a locked move (2nd turn of a charge
        // move, Outrage …) is the only legal choice and counts as the slot's action.
        if (extra.some((x) => x.startsWith("[from]") && x !== "[from] lockedmove")) break;
        const si = stateIndex(id.side, id.slot);
        if (actions[id.side][si]) break;
        const tgt = ident(a3);
        const spread = extra.some((x) => x.startsWith("[spread]"));
        // The log names the Pokémon hit, which may have switched in this turn; the player chose
        // the slot, so take whoever held it at the start of the turn. (Redirection is not undone.)
        const slotName =
          tgt && tgt.slot >= 0 ? (turnActive[tgt.side][tgt.slot] ?? tgt.name) : tgt?.name;
        const target =
          tgt && slotName && !spread && !(tgt.side === id.side && tgt.slot === id.slot)
            ? mons.get(key(tgt.side, slotName))?.species
            : undefined;
        actions[id.side][si] = {
          move: toID(a2 ?? ""),
          ...(target ? { target } : {}),
          ...(megaPending[id.side][si] ? { mega: true } : {}),
        };
        break;
      }
      case "-mega": {
        const id = ident(a1);
        if (id && id.slot >= 0) megaPending[id.side][stateIndex(id.side, id.slot)] = true;
        break;
      }
      case "cant": {
        const id = ident(a1);
        if (id && st.cur && id.slot >= 0) {
          const si = stateIndex(id.side, id.slot);
          actions[id.side][si] ??= { unknown: true };
        }
        break;
      }
      case "-damage":
      case "-heal":
      case "-sethp": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m) {
          // the condition carries the current status ("55/100 brn"; none when cured)
          const c = condition(a2);
          m.hpPct = c.hpPct;
          if (c.hpPct > 0) m.status = c.status;
        }
        break;
      }
      case "-status": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m && STATUSES.has(a2 ?? "")) m.status = a2 as Mon["status"];
        break;
      }
      case "-curestatus": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m) m.status = null;
        break;
      }
      case "-boost":
      case "-unboost": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m && a2) {
          const n = Number(a3 ?? 0) * (tag === "-boost" ? 1 : -1);
          m.boosts[a2] = Math.max(-6, Math.min(6, (m.boosts[a2] ?? 0) + n));
        }
        break;
      }
      case "-setboost": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m && a2) m.boosts[a2] = Number(a3 ?? 0);
        break;
      }
      case "-clearboost":
      case "-clearnegativeboost": {
        const id = ident(a1);
        const m = id && mons.get(key(id.side, id.name));
        if (m)
          for (const s of Object.keys(m.boosts))
            if (tag === "-clearboost" || m.boosts[s]! < 0) m.boosts[s] = 0;
        break;
      }
      case "-clearallboost":
        for (const m of mons.values()) m.boosts = {};
        break;
      case "faint": {
        const id = ident(a1);
        if (!id) break;
        const m = mons.get(key(id.side, id.name));
        if (m) m.hpPct = 0;
        const slot = active[id.side].indexOf(id.name);
        if (slot >= 0) active[id.side][slot] = null;
        break;
      }
      case "upkeep":
        afterUpkeep = true;
        break;
      case "turn":
        startTurn(Number(a1));
        break;
      case "win": {
        const s = players.get(a1 ?? "");
        winner = s ?? null;
        if (s === undefined) issues.push(`winner "${a1}" is not a known player`);
        break;
      }
      case "tie":
        winner = null;
        break;
    }
  }
  finishTurn();
  if (turns.length === 0) issues.push("no |turn| lines found");
  for (const t of turns)
    if (t.replacements && t.replacements[0].length === 0 && t.replacements[1].length === 0)
      delete t.replacements;
  return { brought, turns, winner, issues };
}
