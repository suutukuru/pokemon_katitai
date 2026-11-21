import { displayName } from "@ca/data";
import type { ReplayData } from "@ca/sim";

export interface ReplayPageInput {
  title: string;
  subtitle: string;
  data: ReplayData;
  params: Record<string, number>;
}

/** Collect localized names for every ID the page needs (the page itself has no name table). */
function nameTable(d: ReplayData): Record<string, string> {
  const ids = new Set<string>();
  const moves = new Set<string>();
  const items = new Set<string>();
  for (const m of d.members) {
    ids.add(m.species);
    if (m.item) items.add(m.item);
  }
  for (const t of d.turns) {
    for (const e of t.events) {
      if ("who" in e) ids.add(e.who);
      if (e.t === "move") {
        moves.add(e.move);
        if (e.target) ids.add(e.target.who);
      }
      if ((e.t === "damage" || e.t === "heal") && e.from) items.add(e.from);
    }
    for (const dc of t.decisions) {
      ids.add(dc.species);
      for (const o of dc.options) {
        if (o.option.moveId) moves.add(o.option.moveId);
        if (o.option.targetSpecies) ids.add(o.option.targetSpecies);
      }
    }
    for (const w of t.whatIf ?? [])
      for (const s of w.slots) {
        ids.add(s.species);
        if (s.moveId) moves.add(s.moveId);
        if (s.targetSpecies) ids.add(s.targetSpecies);
      }
  }
  const out: Record<string, string> = {};
  for (const id of ids) out[`s:${id}`] = displayName("species", id);
  for (const id of moves) out[`m:${id}`] = displayName("moves", id);
  for (const id of items) {
    const it = displayName("items", id);
    out[`i:${id}`] = it !== id ? it : displayName("abilities", id);
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Self-contained interactive replay (one HTML file, no network): step through events, HP bars,
 * field state, a win-rate graph and per-turn "what if" alternatives evaluated by rollouts.
 */
export function renderReplayPage(r: ReplayPageInput): string {
  const payload = JSON.stringify({ d: r.data, n: nameTable(r.data), p: r.params }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(r.title)}</title>
<style>
:root{--bg:#f3f4f7;--card:#fff;--fg:#1b2130;--muted:#5d6676;--line:#dde1e8;--me:#2653c7;--op:#b23d1b;--good:#1f7a4d;--warn:#a26200;--bad:#b42318;--hp:#2f9e5b;--hpmid:#d29a12;--hplow:#d23c2a;--chip:#eef1f6;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--me:#7d9bff;--op:#ff8a66;--good:#5fd39a;--warn:#f0b443;--bad:#ff7b72;--hp:#41c27a;--hpmid:#e8b23a;--hplow:#ff6b5b;--chip:#252b36;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--me:#7d9bff;--op:#ff8a66;--good:#5fd39a;--warn:#f0b443;--bad:#ff7b72;--hp:#41c27a;--hpmid:#e8b23a;--hplow:#ff6b5b;--chip:#252b36;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--fg);font:14px/1.5 "Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
main{max-width:620px;margin:0 auto;padding:12px max(14px,env(safe-area-inset-right)) 120px max(14px,env(safe-area-inset-left));display:grid;gap:10px}
h1{font-size:17px;margin:0}.sub{color:var(--muted);font-size:12px;margin:2px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}
.res{font-weight:800}.win{color:var(--good)}.lose{color:var(--bad)}
.graph svg{width:100%;height:auto;display:block}.graph text{fill:var(--muted);font-size:10px}
.field{display:flex;flex-wrap:wrap;gap:6px;min-height:26px}.chip{background:var(--chip);border-radius:999px;padding:2px 9px;font-size:12px}
.chip.me{color:var(--me)}.chip.op{color:var(--op)}
.side{display:grid;gap:6px}.side h3{margin:0;font-size:12px;color:var(--muted);font-weight:600}
.slots{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.mon{border:1px solid var(--line);border-radius:10px;padding:6px 8px;min-width:0;transition:opacity .3s}
.mon.empty{opacity:.35}.mon.fnt{opacity:.4}.mon .nm{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.op .mon{border-left:4px solid var(--op)}.me .mon{border-left:4px solid var(--me)}
.hpbar{height:8px;background:var(--line);border-radius:5px;overflow:hidden;margin:4px 0 2px}.hpbar i{display:block;height:100%;background:var(--hp);transition:width .45s ease}
.hpbar i.mid{background:var(--hpmid)}.hpbar i.low{background:var(--hplow)}
.hpnum{font-size:12px;font-variant-numeric:tabular-nums}.tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}.tag{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:0 6px}
.mon.flash{box-shadow:0 0 0 3px var(--warn)}
.bench{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}
.now{font-size:14px;min-height:42px;display:flex;align-items:center;gap:8px}.now b{font-size:15px}
.log{margin:0;padding-left:20px;font-size:12.5px;max-height:220px;overflow:auto}.log li.cur{font-weight:700;background:var(--chip)}.log li.future{opacity:.35}
.s0{color:var(--me)}.s1{color:var(--op)}
table{width:100%;border-collapse:collapse;font-size:12.5px}td,th{padding:4px 3px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:normal;color:var(--muted);font-size:11px}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.bar{display:block;height:5px;background:var(--line);border-radius:3px;margin-top:3px;overflow:hidden}.bar i{display:block;height:100%;background:var(--me)}
tr.chosen td{background:var(--chip);font-weight:700}.best{color:var(--good);font-weight:700}.blunder{color:var(--bad);font-weight:700}.plus{color:var(--good)}.minus{color:var(--bad)}
.controls{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:8px max(12px,env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));display:grid;gap:6px}
.btns{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;max-width:620px;margin:0 auto;width:100%}
button{font:inherit;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--chip);color:var(--fg)}button.play{background:var(--me);color:#fff;border-color:var(--me)}
button:focus-visible{outline:2px solid var(--me);outline-offset:2px}
input[type=range]{width:100%;max-width:620px;margin:0 auto;display:block}
details summary{cursor:pointer;color:var(--me);font-size:13px}
.foot{font-size:11.5px;color:var(--muted)}
@media (prefers-reduced-motion:reduce){.hpbar i,.mon{transition:none}}
</style></head><body><main>
<div><h1>${esc(r.title)}</h1><p class="sub">${esc(r.subtitle)}</p><p class="res" id="res"></p></div>
<section class="card graph"><div class="sub">勝率の推移（その時点の局面から、実際に選んだ行動で${r.data.rollouts}戦ずつシミュレーション）。点をタップでそのターンへ。</div><div id="graph"></div></section>
<section class="card"><div class="field" id="field" aria-label="場の状態"></div></section>
<section class="card side op"><h3>相手</h3><div class="slots" id="op"></div><div class="bench" id="opb"></div></section>
<section class="card side me"><h3>自分</h3><div class="slots" id="me"></div><div class="bench" id="meb"></div></section>
<section class="card"><div class="now" id="now" aria-live="polite"></div><ol class="log" id="log"></ol></section>
<section class="card" id="whatif"></section>
<section class="card" id="ai"></section>
<p class="foot">勝率は、その時点の局面を保存し、その行動を選んだあと両者AIで最後まで対戦させた結果（各${r.data.rollouts}戦、相手の行動はAIの確率に従う）。差が大きい行動ほど、その場面での判断が勝敗に効いている。AIの評価値＝予想ダメージ割合（命中込み）＋倒せそうなら +${r.params["koBonus"] ?? "?"} など。ダメージ・行動順・急所は対戦エンジン（Pokémon Showdown の Champions ルール）が決める。相手の技は使用率データからの推定を含む。</p>
</main>
<div class="controls"><input type="range" id="seek" min="0" value="0" aria-label="再生位置"><div class="btns">
<button id="pt" aria-label="前のターン">⏮</button><button id="pe" aria-label="1つ戻る">◀</button><button id="play" class="play" aria-label="再生">▶ 再生</button><button id="ne" aria-label="1つ進む">▶</button><button id="nt" aria-label="次のターン">⏭</button></div></div>
<script id="payload" type="application/json">${payload}</script>
<script>
(() => {
const {d, n, p} = JSON.parse(document.getElementById("payload").textContent);
const S = (id) => n["s:" + id] || id, M = (id) => n["m:" + id] || id, I = (id) => n["i:" + id] || id;
const SIDE = ["自分", "相手"];
const W = {SunnyDay: "はれ", RainDance: "あめ", Sandstorm: "すなあらし", Snowscape: "ゆき", DesolateLand: "おおひでり", PrimordialSea: "おおあめ"};
const C = {tailwind: "おいかぜ", trickroom: "トリックルーム", reflect: "リフレクター", lightscreen: "ひかりのかべ", auroraveil: "オーロラベール", psychicterrain: "サイコフィールド", grassyterrain: "グラスフィールド", electricterrain: "エレキフィールド", mistyterrain: "ミストフィールド"};
const ST = {par: "まひ", slp: "ねむり", brn: "やけど", psn: "どく", tox: "もうどく", frz: "こおり"};
const STAT = {atk: "こうげき", def: "ぼうぎょ", spa: "とくこう", spd: "とくぼう", spe: "すばやさ", accuracy: "命中", evasion: "回避"};
const res = d.result.winner === 0 ? "勝ち" : d.result.winner === 1 ? "負け" : "引き分け";
const resEl = document.getElementById("res");
resEl.textContent = res + "（" + d.result.turns + "ターン、残り " + d.result.remaining[0] + " 対 " + d.result.remaining[1] + "）";
resEl.className = "res " + (d.result.winner === 0 ? "win" : "lose");
// flat step list: each step = one event (turn headers are steps too)
const steps = [];
d.turns.forEach((t, ti) => { steps.push({ti, head: true}); t.events.forEach((e, ei) => steps.push({ti, e})); });
const seek = document.getElementById("seek"); seek.max = steps.length - 1;
const key = (side, who) => side + ":" + who;
function stateAt(pos) {
  const st = {mons: {}, slots: [[null, null], [null, null]], weather: "", field: new Set(), sides: [new Set(), new Set()], flash: null};
  for (const m of d.members) st.mons[key(m.side, m.species)] = {side: m.side, who: m.species, hp: 100, status: "", mega: false, fnt: false, seen: false, boosts: {}};
  for (let i = 0; i <= pos; i++) {
    const e = steps[i].e; if (!e) continue;
    const m = "who" in e ? st.mons[key(e.side, e.who)] : null;
    switch (e.t) {
      case "switch": if (m) { m.hp = e.hp; m.seen = true; const s = st.slots[e.side]; const old = s.indexOf(e.who); if (old >= 0) s[old] = null; s[e.slot] = e.who; m.boosts = {}; } break;
      case "damage": case "heal": if (m) m.hp = e.hp; break;
      case "faint": if (m) { m.hp = 0; m.fnt = true; } break;
      case "status": if (m) m.status = e.status; break;
      case "mega": if (m) m.mega = true; break;
      case "boost": if (m) m.boosts[e.stat] = (m.boosts[e.stat] || 0) + e.n; break;
      case "weather": st.weather = e.weather === "none" ? "" : e.weather; break;
      case "fieldstart": st.field.add(e.cond); break;
      case "fieldend": st.field.delete(e.cond); break;
      case "sidestart": st.sides[e.side].add(e.cond); break;
      case "sideend": st.sides[e.side].delete(e.cond); break;
    }
    if (i === pos && m) st.flash = key(e.side, e.who);
  }
  return st;
}
function hpClass(h) { return h > 50 ? "" : h > 20 ? "mid" : "low"; }
function monCard(m, flash) {
  if (!m) return '<div class="mon empty"><div class="nm">—</div></div>';
  const tags = [];
  if (m.mega) tags.push('<span class="tag">メガ</span>');
  if (m.status) tags.push('<span class="tag">' + (ST[m.status] || m.status) + '</span>');
  for (const [s, v] of Object.entries(m.boosts)) if (v) tags.push('<span class="tag">' + (STAT[s] || s) + (v > 0 ? "+" : "") + v + '</span>');
  return '<div class="mon ' + (m.fnt ? "fnt " : "") + (flash ? "flash" : "") + '"><div class="nm">' + (m.mega ? "メガ" : "") + S(m.who) + '</div><div class="hpbar"><i class="' + hpClass(m.hp) + '" style="width:' + m.hp + '%"></i></div><div class="hpnum">HP ' + m.hp + '%' + (m.fnt ? "（たおれた）" : "") + '</div><div class="tags">' + tags.join("") + '</div></div>';
}
function eventText(e) {
  const w = (x) => '<span class="s' + x.side + '">' + S(x.who) + '</span>';
  switch (e.t) {
    case "switch": return SIDE[e.side] + ": " + w(e) + " が登場";
    case "move": return w(e) + " の <b>" + M(e.move) + "</b>" + (e.spread ? "（全体）" : e.target && !(e.target.side === e.side && e.target.who === e.who) ? " → " + w(e.target) : "");
    case "damage": return w(e) + " 残りHP <b>" + e.hp + "%</b>" + (e.from ? "（" + I(e.from) + "）" : "");
    case "heal": return w(e) + " 回復 → " + e.hp + "%" + (e.from ? "（" + I(e.from) + "）" : "");
    case "faint": return w(e) + " <b>たおれた</b>";
    case "crit": return "急所に当たった";
    case "super": return "効果はばつぐん";
    case "resisted": return "効果はいまひとつ";
    case "immune": return w(e) + " には効果がない";
    case "miss": return w(e) + " には当たらなかった";
    case "fail": return "うまく決まらなかった";
    case "protected": return w(e) + " はまもった";
    case "mega": return w(e) + " がメガシンカ";
    case "boost": return w(e) + " の" + (STAT[e.stat] || e.stat) + " " + (e.n > 0 ? "+" : "") + e.n;
    case "status": return w(e) + " は" + (ST[e.status] || e.status) + "になった";
    case "cant": return w(e) + " は動けない（" + (ST[e.reason] || (e.reason === "flinch" ? "ひるみ" : e.reason)) + "）";
    case "weather": return e.upkeep ? (W[e.weather] || e.weather) + "が続いている" : "天気: " + (W[e.weather] || e.weather || "なし");
    case "sidestart": return SIDE[e.side] + "の" + (C[e.cond] || e.cond) + "が始まった";
    case "sideend": return SIDE[e.side] + "の" + (C[e.cond] || e.cond) + "が終わった";
    case "fieldstart": return (C[e.cond] || e.cond) + "が始まった";
    case "fieldend": return (C[e.cond] || e.cond) + "が終わった";
  }
  return "";
}
function optLabel(slots) { return slots.map((s) => S(s.species) + (s.mega ? "(メガ)" : "") + ": " + (s.moveId ? M(s.moveId) + (s.targetSpecies ? "→" + S(s.targetSpecies) : "") : "交代")).join(" ＋ "); }
const pct = (x) => Math.round(x * 100) + "%";
function whatIfHtml(t) {
  if (!t.whatIf) return '<div class="sub">このターンは選択肢の分析がありません（交代のみ等）。</div>';
  const chosen = t.whatIf.find((w) => w.chosen);
  const best = Math.max(...t.whatIf.map((w) => w.winRate));
  const rows = [...t.whatIf].sort((a, b) => b.winRate - a.winRate).map((w) => {
    const dlt = chosen ? Math.round((w.winRate - chosen.winRate) * 100) : 0;
    const mark = w.winRate === best ? '<span class="best">★最善</span> ' : "";
    return '<tr class="' + (w.chosen ? "chosen" : "") + '"><td>' + (w.chosen ? "✔ " : "") + mark + optLabel(w.slots) + '<span class="bar"><i style="width:' + Math.round(w.winRate * 100) + '%"></i></span></td><td class="n">' + pct(w.winRate) + '</td><td class="n ' + (dlt > 0 ? "plus" : dlt < 0 ? "minus" : "") + '">' + (w.chosen ? "実際" : (dlt > 0 ? "+" : "") + dlt) + '</td></tr>';
  }).join("");
  const loss = chosen ? Math.round((best - chosen.winRate) * 100) : 0;
  const verdict = !chosen ? "" : loss >= 15 ? '<p class="blunder">実際の行動は最善より ' + loss + ' ポイント低い（悪手の可能性）</p>' : loss >= 6 ? '<p class="minus">実際の行動は最善より ' + loss + ' ポイント低い</p>' : '<p class="plus">実際の行動はほぼ最善</p>';
  return '<h3 style="margin:0 0 4px;font-size:14px">' + t.turn + 'ターン目：もしこう動いていたら（自分）</h3>' + verdict + '<table><thead><tr><th>行動</th><th>勝率</th><th>差</th></tr></thead><tbody>' + rows + '</tbody></table>';
}
function aiHtml(t) {
  if (!t.decisions.length) return "";
  const rows = t.decisions.sort((a, b) => a.side - b.side).map((dc) => {
    const ranked = dc.options.map((o, i) => ({...o, i})).sort((a, b) => b.prob - a.prob).slice(0, 4);
    if (!ranked.some((x) => x.i === dc.chosen)) ranked.push({...dc.options[dc.chosen], i: dc.chosen});
    return '<tr><td colspan="3" class="s' + dc.side + '"><b>' + SIDE[dc.side] + ": " + S(dc.species) + '</b> HP ' + dc.hpPct + '%</td></tr>' + ranked.map((x) => '<tr class="' + (x.i === dc.chosen ? "chosen" : "") + '"><td>' + (x.i === dc.chosen ? "✔ " : "") + (x.option.moveId ? M(x.option.moveId) + (x.option.targetSpecies ? "→" + S(x.option.targetSpecies) : "") : "交代") + '</td><td class="n">' + x.option.score.toFixed(2) + '</td><td class="n">' + pct(x.prob) + '</td></tr>').join("");
  }).join("");
  return '<details><summary>AIの評価値と選ぶ確率（' + t.turn + 'ターン目）</summary><table><thead><tr><th>候補</th><th>評価値</th><th>確率</th></tr></thead><tbody>' + rows + '</tbody></table></details>';
}
function graph() {
  const pts = d.turns.filter((t) => t.whatIf && t.whatIf.some((w) => w.chosen)).map((t) => ({turn: t.turn, v: t.whatIf.find((w) => w.chosen).winRate, best: Math.max(...t.whatIf.map((w) => w.winRate))}));
  if (!pts.length) return "";
  const Wd = 600, H = 150, L = 30, R = 10, T = 10, B = 22, maxT = Math.max(...pts.map((x) => x.turn), 1);
  const x = (t) => L + (Wd - L - R) * (maxT === 1 ? 0.5 : (t - 1) / (maxT - 1)), y = (v) => T + (H - T - B) * (1 - v);
  const line = pts.map((q, i) => (i ? "L" : "M") + x(q.turn).toFixed(1) + " " + y(q.v).toFixed(1)).join(" ");
  const bestLine = pts.map((q, i) => (i ? "L" : "M") + x(q.turn).toFixed(1) + " " + y(q.best).toFixed(1)).join(" ");
  let g = '<svg viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="ターンごとの勝率">';
  for (const v of [0, .5, 1]) g += '<line x1="' + L + '" x2="' + (Wd - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)" stroke-dasharray="' + (v === .5 ? "4 3" : "0") + '"/><text x="2" y="' + (y(v) + 3) + '">' + (v * 100) + '%</text>';
  g += '<path d="' + bestLine + '" fill="none" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="5 4"/>';
  g += '<path d="' + line + '" fill="none" stroke="var(--me)" stroke-width="2.5"/>';
  for (const q of pts) g += '<g data-turn="' + q.turn + '" style="cursor:pointer"><circle cx="' + x(q.turn) + '" cy="' + y(q.v) + '" r="9" fill="transparent"/><circle cx="' + x(q.turn) + '" cy="' + y(q.v) + '" r="4" fill="' + (q.best - q.v >= .15 ? "var(--bad)" : "var(--me)") + '"/><text x="' + x(q.turn) + '" y="' + (H - 6) + '" text-anchor="middle">' + q.turn + '</text></g>';
  g += '</svg><div class="sub">青＝実際の行動の勝率、緑の点線＝そのターンの最善手の勝率、赤い点＝最善より15ポイント以上低い行動</div>';
  return g;
}
document.getElementById("graph").innerHTML = graph();
document.querySelectorAll("#graph g[data-turn]").forEach((g) => g.addEventListener("click", () => { const t = +g.dataset.turn; go(steps.findIndex((s) => s.head && d.turns[s.ti].turn === t)); }));
let pos = 0, timer = null;
function render() {
  const st = stateAt(pos), step = steps[pos], t = d.turns[step.ti];
  seek.value = pos;
  const f = [];
  if (st.weather) f.push('<span class="chip">天気: ' + (W[st.weather] || st.weather) + '</span>');
  for (const c of st.field) f.push('<span class="chip">' + (C[c] || c) + '</span>');
  st.sides.forEach((set, s) => { for (const c of set) f.push('<span class="chip ' + (s ? "op" : "me") + '">' + SIDE[s] + ": " + (C[c] || c) + '</span>'); });
  document.getElementById("field").innerHTML = f.length ? f.join("") : '<span class="chip">場の効果なし</span>';
  for (const side of [0, 1]) {
    const el = document.getElementById(side ? "op" : "me");
    el.innerHTML = st.slots[side].map((w) => monCard(w ? st.mons[key(side, w)] : null, w && st.flash === key(side, w))).join("");
    const bench = Object.values(st.mons).filter((m) => m.side === side && !st.slots[side].includes(m.who));
    document.getElementById(side ? "opb" : "meb").innerHTML = bench.length ? "控え: " + bench.map((m) => S(m.who) + " " + (m.fnt ? "×" : m.seen ? m.hp + "%" : "未登場")).join(" ／ ") : "";
  }
  const nowTxt = step.head ? "<b>" + (t.turn === 0 ? "対戦開始" : t.turn + "ターン目") + "</b>" : eventText(step.e);
  document.getElementById("now").innerHTML = nowTxt;
  const turnSteps = steps.map((s, i) => ({s, i})).filter((x) => x.s.ti === step.ti && !x.s.head);
  document.getElementById("log").innerHTML = turnSteps.map((x) => '<li class="' + (x.i === pos ? "cur" : x.i > pos ? "future" : "") + '">' + eventText(x.s.e) + '</li>').join("");
  document.getElementById("whatif").innerHTML = whatIfHtml(t);
  document.getElementById("ai").innerHTML = aiHtml(t);
}
function go(i) { pos = Math.max(0, Math.min(steps.length - 1, i)); render(); }
const turnStart = (dir) => { let i = pos + dir; while (i > 0 && i < steps.length && !steps[i].head) i += dir; return i; };
document.getElementById("ne").onclick = () => go(pos + 1);
document.getElementById("pe").onclick = () => go(pos - 1);
document.getElementById("nt").onclick = () => go(turnStart(1));
document.getElementById("pt").onclick = () => go(steps[pos].head ? turnStart(-1) : turnStart(-1) + 0);
seek.oninput = () => go(+seek.value);
const playBtn = document.getElementById("play");
playBtn.onclick = () => {
  if (timer) { clearInterval(timer); timer = null; playBtn.textContent = "▶ 再生"; return; }
  playBtn.textContent = "⏸ 停止";
  timer = setInterval(() => { if (pos >= steps.length - 1) { clearInterval(timer); timer = null; playBtn.textContent = "▶ 再生"; return; } go(pos + 1); }, 650);
};
render();
})();
</script></body></html>`;
}
