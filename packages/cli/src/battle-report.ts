import { displayName } from "@ca/data";
import type { BattleEvent, BattleLog, DecisionTrace } from "@ca/sim";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sp = (id: string) => esc(displayName("species", id));
const mv = (id: string) => esc(displayName("moves", id));
const SIDE = ["自分", "相手"] as const;
const WEATHER: Record<string, string> = {
  SunnyDay: "はれ",
  RainDance: "あめ",
  Sandstorm: "すなあらし",
  Snowscape: "ゆき",
  none: "なし",
};
const STAT: Record<string, string> = {
  atk: "こうげき",
  def: "ぼうぎょ",
  spa: "とくこう",
  spd: "とくぼう",
  spe: "すばやさ",
  accuracy: "命中",
  evasion: "回避",
};
const STATUS: Record<string, string> = {
  par: "まひ",
  slp: "ねむり",
  brn: "やけど",
  psn: "どく",
  tox: "もうどく",
  frz: "こおり",
};
const COND: Record<string, string> = {
  tailwind: "おいかぜ",
  trickroom: "トリックルーム",
  reflect: "リフレクター",
  lightscreen: "ひかりのかべ",
  auroraveil: "オーロラベール",
  psychicterrain: "サイコフィールド",
  grassyterrain: "グラスフィールド",
  electricterrain: "エレキフィールド",
  mistyterrain: "ミストフィールド",
};

function fromLabel(id: string): string {
  const it = displayName("items", id);
  if (it !== id) return it;
  const ab = displayName("abilities", id);
  return ab !== id ? ab : id;
}

/** Japanese lines for one turn's events. Effectiveness/crit flags are attached to the next damage line. */
export function eventLines(events: BattleEvent[]): string[] {
  const out: string[] = [];
  let flags: string[] = [];
  const who = (e: { side: 0 | 1; who: string }) => `<span class="s${e.side}">${sp(e.who)}</span>`;
  for (const e of events) {
    switch (e.t) {
      case "switch":
        out.push(`${SIDE[e.side]}: ${who(e)} が登場`);
        break;
      case "move": {
        const tgt = e.spread
          ? "（全体）"
          : e.target && !(e.target.side === e.side && e.target.who === e.who)
            ? ` → ${who(e.target)}`
            : "";
        out.push(`<b>${who(e)} の ${mv(e.move)}</b>${tgt}`);
        break;
      }
      case "crit":
        flags.push("急所");
        break;
      case "super":
        flags.push("ばつぐん");
        break;
      case "resisted":
        flags.push("いまひとつ");
        break;
      case "immune":
        out.push(`&emsp;${who(e)} には効果がない`);
        break;
      case "damage":
        out.push(
          `&emsp;${who(e)} 残りHP <b>${e.hp}%</b>${e.from ? `（${esc(fromLabel(e.from))}）` : ""}${flags.length ? ` <i>${flags.join("・")}</i>` : ""}`,
        );
        flags = [];
        break;
      case "heal":
        out.push(`&emsp;${who(e)} 回復 → ${e.hp}%${e.from ? `（${esc(fromLabel(e.from))}）` : ""}`);
        break;
      case "faint":
        out.push(`&emsp;<b class="ko">${who(e)} たおれた</b>`);
        break;
      case "miss":
        out.push(`&emsp;${who(e)} には当たらなかった`);
        break;
      case "fail":
        out.push(`&emsp;うまく決まらなかった`);
        break;
      case "protected":
        out.push(`&emsp;${who(e)} はまもった`);
        break;
      case "mega":
        out.push(`${who(e)} がメガシンカ`);
        break;
      case "boost":
        out.push(`&emsp;${who(e)} の${STAT[e.stat] ?? e.stat} ${e.n > 0 ? "+" : ""}${e.n}`);
        break;
      case "status":
        out.push(`&emsp;${who(e)} は${STATUS[e.status] ?? e.status}になった`);
        break;
      case "cant":
        out.push(
          `&emsp;${who(e)} は動けない（${STATUS[e.reason] ?? (e.reason === "flinch" ? "ひるみ" : e.reason)}）`,
        );
        break;
      case "weather":
        if (!e.upkeep) out.push(`天気: ${WEATHER[e.weather] ?? e.weather}`);
        break;
      case "sidestart":
      case "sideend":
        out.push(
          `${SIDE[e.side]}の${COND[e.cond] ?? e.cond}が${e.t === "sidestart" ? "始まった" : "終わった"}`,
        );
        break;
      case "fieldstart":
      case "fieldend":
        out.push(`${COND[e.cond] ?? e.cond}が${e.t === "fieldstart" ? "始まった" : "終わった"}`);
        break;
    }
  }
  return out;
}

function optionLabel(o: DecisionTrace["options"][number]["option"]): string {
  if (!o.moveId) return o.choice.startsWith("switch") ? "交代" : "—";
  return `${mv(o.moveId)}${o.targetSpecies ? ` → ${sp(o.targetSpecies)}` : ""}${o.choice.endsWith(" mega") ? "（メガ）" : ""}`;
}

function decisionHtml(d: DecisionTrace): string {
  const ranked = d.options.map((o, i) => ({ ...o, i })).sort((a, b) => b.prob - a.prob);
  const shown = ranked.slice(0, 3);
  if (!shown.some((x) => x.i === d.chosen)) shown.push(ranked.find((x) => x.i === d.chosen)!);
  const rows = shown
    .map(
      (x) =>
        `<tr class="${x.i === d.chosen ? "chosen" : ""}"><td>${x.i === d.chosen ? "✔ " : ""}${optionLabel(x.option)}</td><td class="num">${x.option.score.toFixed(2)}</td><td class="num">${Math.round(x.prob * 100)}%<span class="pb"><i style="width:${Math.round(x.prob * 100)}%"></i></span></td></tr>`,
    )
    .join("");
  return `<div class="dec s${d.side}"><div class="dh">${SIDE[d.side]}: <b>${sp(d.species)}</b> <small>HP ${d.hpPct}%</small></div><table><thead><tr><th>候補</th><th>評価値</th><th>選ぶ確率</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export interface BattleReportInput {
  title: string;
  log: BattleLog;
  /** e.g. "この選出同士で30戦: 勝率 63%" */
  summary: string;
  params: Record<string, number>;
}

/** Turn-by-turn battle report (decisions with scores/probabilities, events, HP). */
export function renderBattleReport(r: BattleReportInput): string {
  const { log } = r;
  const res = log.result.winner === 0 ? "勝ち" : log.result.winner === 1 ? "負け" : "引き分け";
  const turns = log.turns
    .map((t) => {
      const dec = [...t.decisions]
        .sort((a, b) => a.side - b.side)
        .map(decisionHtml)
        .join("");
      const ev = eventLines(t.events)
        .map((l) => `<li>${l}</li>`)
        .join("");
      const hp = [0, 1]
        .map((side) =>
          t.hp
            .filter((h) => h.side === side)
            .map(
              (h) =>
                `<span class="hp ${h.hp === 0 ? "dead" : ""} ${h.active ? "act" : ""}">${sp(h.who)} <b>${h.hp}%</b><span class="hb"><i style="width:${h.hp}%"></i></span></span>`,
            )
            .join(""),
        )
        .map((x, i) => `<div class="hprow"><em>${SIDE[i]}</em>${x}</div>`)
        .join("");
      return `<section class="turn"><h2>${t.turn === 0 ? "対戦開始" : `${t.turn}ターン目`}</h2>${dec ? `<div class="decs">${dec}</div>` : ""}${ev ? `<ol class="ev">${ev}</ol>` : ""}<div class="hps">${hp}</div></section>`;
    })
    .join("\n");
  const p = (k: string) => r.params[k] ?? "?";
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title>
<style>
:root{--bg:#f4f5f8;--card:#fff;--fg:#1c2230;--muted:#5d6676;--line:#dde1e8;--me:#2753c9;--op:#b3401e;--good:#1f7a4d;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 "Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif}
main{padding:14px;display:grid;gap:10px}h1{font-size:18px;margin:0}.sub{color:var(--muted);font-size:12.5px;margin:2px 0 0}
.res{font-size:20px;font-weight:800}.res.win{color:var(--good)}.res.lose{color:var(--bad)}
.turn{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;display:grid;gap:8px}
.turn h2{font-size:15px;margin:0}.decs{display:grid;gap:6px}
.dec{border-left:4px solid var(--me);padding-left:8px}.dec.s1{border-left-color:var(--op)}.dh{font-size:13px}.dh small{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{color:var(--muted);font-weight:normal;text-align:left;font-size:11px}
td,th{padding:2px 4px;border-bottom:1px solid var(--line)}td.num,th:nth-child(n+2){text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.chosen td{font-weight:700;background:#eef3ff}.pb{display:inline-block;width:42px;height:6px;background:var(--line);border-radius:3px;margin-left:4px;vertical-align:middle;overflow:hidden}.pb i{display:block;height:100%;background:var(--me)}
.s1 .pb i{background:var(--op)}
.ev{margin:0;padding-left:18px;font-size:13px}.ev i{font-style:normal;font-size:11.5px;border:1px solid var(--line);border-radius:999px;padding:0 5px;margin-left:4px}
span.s0{color:var(--me)}span.s1{color:var(--op)}.ko{color:var(--bad)}
.hps{display:grid;gap:4px;border-top:1px dashed var(--line);padding-top:6px}.hprow{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:12px}.hprow em{font-style:normal;color:var(--muted);width:2.5em}
.hp{display:inline-flex;align-items:center;gap:3px;opacity:.55}.hp.act{opacity:1;font-weight:600}.hp.dead{text-decoration:line-through;opacity:.45}
.hb{display:inline-block;width:34px;height:5px;background:var(--line);border-radius:3px;overflow:hidden}.hb i{display:block;height:100%;background:var(--good)}
footer{font-size:11.5px;color:var(--muted);line-height:1.6}
</style></head><body><main>
<div><h1>${esc(r.title)}</h1><p class="sub">${esc(r.summary)} ／ シード ${log.seed}</p></div>
<div class="res ${log.result.winner === 0 ? "win" : "lose"}">${res}（${log.result.turns}ターン、残り ${log.result.remaining[0]} 対 ${log.result.remaining[1]}）</div>
<div class="sub">自分の選出: ${log.brought[0].map(sp).join("・")} ／ 相手の選出: ${log.brought[1].map(sp).join("・")}（それぞれ先頭2匹が先発）</div>
${turns}
<footer>評価値＝その行動の見込みの点数（行動AIの計算）。攻撃技は「相手に与える予想ダメージ（相手の最大HPに対する割合、命中率込み）」、倒せそうなら +${p("koBonus")}。まもるは基本 ${p("protectBase")}＋倒されそうなほど加点、連続だと −${p("protectRepeatPenalty")}。おいかぜ ${p("tailwindValue")}、トリックルーム ${p("trickRoomValue")}、ねこだまし +${p("fakeOutValue")}（初回のみ）。<br>選ぶ確率＝評価値の差を温度（自分 ${p("selfTemperature")}、相手 ${p("temperature")}）で確率に変えたもの（ソフトマックス）。温度が低いほど評価の高い行動に集中する。高い評価の行動ほど選ばれやすいが、低い行動も一定の確率で選ぶ（相手の読み・ブレを表すため）。ダメージ・行動順・急所・命中は対戦エンジン（Pokémon Showdown の Champions ルール）が決める。</footer>
</main></body></html>`;
}
