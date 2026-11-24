// Japanese labels for battle data (names come from the bundled name table).
import { displayName } from "@ca/data";
import type { BattleEvent, OptionSlot } from "@ca/sim";

export const sp = (id: string) => displayName("species", id);
export const mv = (id: string) => displayName("moves", id);
export const it = (id: string) => (id ? displayName("items", id) : "");
export const ab = (id: string) => displayName("abilities", id);
export const pct = (x: number) => `${Math.round(x * 100)}%`;

const toId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const WEATHER: Record<string, string> = {
  sunnyday: "にほんばれ",
  desolateland: "おおひでり",
  raindance: "あめ",
  primordialsea: "おおあめ",
  sandstorm: "すなあらし",
  snowscape: "ゆき",
  snow: "ゆき",
  hail: "あられ",
};
export const weatherLabel = (w: string) => (w ? (WEATHER[toId(w)] ?? w) : "");

const STATUS: Record<string, string> = {
  brn: "やけど",
  par: "まひ",
  slp: "ねむり",
  frz: "こおり",
  psn: "どく",
  tox: "もうどく",
};
export const statusLabel = (s: string) => STATUS[s] ?? s;

const STAT: Record<string, string> = {
  atk: "攻撃",
  def: "防御",
  spa: "特攻",
  spd: "特防",
  spe: "素早さ",
  accuracy: "命中",
  evasion: "回避",
};
export const statLabel = (s: string) => STAT[s] ?? s;

/** Field / side condition (move-named conditions use the move's name). */
export function condLabel(id: string): string {
  const x = toId(id);
  if (WEATHER[x]) return WEATHER[x]!;
  if (x.endsWith("terrain")) return mv(x);
  return mv(x) !== x ? mv(x) : id;
}

const INTENT: Record<string, string> = {
  P: "まもる系",
  S: "全体攻撃",
  X: "補助技",
};

export function slotText(s: OptionSlot, withSpecies = true): string {
  const who = withSpecies && s.species ? `${sp(s.species)}: ` : "";
  if (s.intent && !s.intent.startsWith("M:")) {
    const tgt = s.targetSpecies ? ` → ${sp(s.targetSpecies)}` : "";
    if (s.intent.startsWith("A")) return `${who}一番強い攻撃${tgt}`;
    if (s.intent.startsWith("F")) return `${who}ねこだまし（持っていれば）${tgt}`;
    if (s.intent.startsWith("W"))
      return `${who}${s.switchTo ? `${sp(s.switchTo)}に交代` : "控えに交代"}`;
    return `${who}${INTENT[s.intent] ?? s.intent}`;
  }
  if (s.switchTo) return `${who}${sp(s.switchTo)}に交代`;
  if (!s.moveId) return `${who}—`;
  const tgt = s.targetSpecies ? ` → ${sp(s.targetSpecies)}` : "";
  return `${who}${s.mega ? "メガシンカ＋" : ""}${mv(s.moveId)}${tgt}`;
}

/** indent for lines that belong to the previous move (full-width space) */
const IND = "\u3000";
const side = (s: 0 | 1) => (s === 0 ? "" : "相手の");

export function eventText(e: BattleEvent): string | null {
  switch (e.t) {
    case "switch":
      return `${side(e.side)}${sp(e.who)} が出てきた`;
    case "move":
      return `${side(e.side)}${sp(e.who)} の ${mv(e.move)}${
        e.target && !(e.target.side === e.side && e.target.who === e.who) && !e.spread
          ? `（→ ${side(e.target.side)}${sp(e.target.who)}）`
          : ""
      }`;
    case "damage":
      return `${IND}${side(e.side)}${sp(e.who)} 残りHP ${e.hp}%${e.from ? `（${it(e.from) || e.from}）` : ""}`;
    case "heal":
      return `${IND}${side(e.side)}${sp(e.who)} 回復 → ${e.hp}%${e.from ? `（${it(e.from) || e.from}）` : ""}`;
    case "faint":
      return `${IND}${side(e.side)}${sp(e.who)} は たおれた`;
    case "crit":
      return IND + "急所に当たった";
    case "super":
      return IND + "効果はばつぐん";
    case "resisted":
      return IND + "効果はいまひとつ";
    case "immune":
      return `${IND}${side(e.side)}${sp(e.who)} には効果がない`;
    case "miss":
      return `${IND}${side(e.side)}${sp(e.who)} には当たらなかった`;
    case "fail":
      return IND + "うまく決まらなかった";
    case "protected":
      return `${IND}${side(e.side)}${sp(e.who)} は守った`;
    case "mega":
      return `${side(e.side)}${sp(e.who)} がメガシンカ`;
    case "boost":
      return `${IND}${side(e.side)}${sp(e.who)} の${statLabel(e.stat)} ${e.n > 0 ? "+" : ""}${e.n}`;
    case "status":
      return `${IND}${side(e.side)}${sp(e.who)} は ${statusLabel(e.status)}`;
    case "cant":
      return `${IND}${side(e.side)}${sp(e.who)} は動けない（${e.reason === "flinch" ? "ひるみ" : e.reason === "par" ? "まひ" : e.reason === "slp" ? "ねむり" : e.reason}）`;
    case "weather":
      return e.upkeep ? null : `天気: ${weatherLabel(e.weather) || "なし"}`;
    case "sidestart":
      return `${e.side === 0 ? "自分" : "相手"}の場: ${condLabel(e.cond)}`;
    case "sideend":
      return `${e.side === 0 ? "自分" : "相手"}の${condLabel(e.cond)} が終わった`;
    case "fieldstart":
      return `場: ${condLabel(e.cond)}`;
    case "fieldend":
      return `${condLabel(e.cond)} が終わった`;
  }
}
