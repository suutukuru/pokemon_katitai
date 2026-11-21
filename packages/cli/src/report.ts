import { displayName } from "@ca/data";
import type { MetaRow } from "./sim-commands.js";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const nm = (id: string) => esc(displayName("species", id));
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Display bands for a win rate (UI only; the number itself is always shown). */
function band(rate: number): { cls: string; mark: string; word: string } {
  if (rate >= 0.55) return { cls: "good", mark: "▲", word: "有利" };
  if (rate >= 0.45) return { cls: "even", mark: "●", word: "五分" };
  return { cls: "bad", mark: "▼", word: "不利" };
}

export interface MetaReportInput {
  teamName: string;
  regulation: string;
  mine: string[];
  rows: MetaRow[];
  date: string;
  usageSource: string;
}

/** Self-contained HTML report for phone screens (rendered to PNG for chat). Hardest matchups first. */
export function renderMetaReport(r: MetaReportInput): string {
  const rows = [...r.rows].sort((a, b) => a.winRate - b.winRate || a.label.localeCompare(b.label));
  const avg = rows.length ? rows.reduce((a, x) => a + x.winRate, 0) / rows.length : 0;
  const wins = rows.filter((x) => x.winRate >= 0.5).length;
  const battles = rows.reduce((a, x) => a + x.battles, 0);
  const cards = rows
    .map((x) => {
      const b = band(x.winRate);
      return `<article class="card ${b.cls}">
  <header><span class="label">${esc(x.label)}</span><span class="verdict">${b.mark} ${b.word}</span></header>
  <div class="opp">${x.opponent.map(nm).join("・")}${x.missing.length ? `<span class="note">（${x.missing.map(nm).join("・")}は型不明で除外）</span>` : ""}</div>
  <div class="rate"><b>${pct(x.winRate)}</b><span class="bar"><i style="width:${Math.round(x.winRate * 100)}%"></i></span><small>最低 ${pct(x.safestRate)}</small></div>
  <dl>
    <dt>選出</dt><dd>先発 <b>${nm(x.bring[0]!)}・${nm(x.bring[1]!)}</b> ／ 控え ${nm(x.bring[2]!)}・${nm(x.bring[3]!)}</dd>
    <dt>1ターン目</dt><dd>${esc(x.turnOne)}${x.isGuess ? ' <span class="guess">択あり</span>' : ""}</dd>
  </dl>
</article>`;
    })
    .join("\n");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.teamName)} 上位構築シミュレーション</title>
<style>
:root{--bg:#f4f5f8;--card:#fff;--fg:#1c2230;--muted:#5d6676;--line:#dde1e8;--good:#1f7a4d;--even:#9a6a00;--bad:#b42318;--accent:#3559e0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",system-ui,sans-serif}
main{padding:16px;display:grid;gap:12px}
h1{font-size:19px;margin:0}.sub{color:var(--muted);font-size:12.5px;margin:2px 0 0}
.summary{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px;text-align:center}
.summary b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.summary span{font-size:12px;color:var(--muted)}
.mine{font-size:13px;color:var(--muted)}.mine b{color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--muted);border-radius:12px;padding:10px 12px;display:grid;gap:6px}
.card.good{border-left-color:var(--good)}.card.even{border-left-color:var(--even)}.card.bad{border-left-color:var(--bad)}
.card header{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.label{font-weight:700}
.verdict{font-weight:700;font-size:13px}.good .verdict{color:var(--good)}.even .verdict{color:var(--even)}.bad .verdict{color:var(--bad)}
.opp{font-size:12.5px;color:var(--muted)}.note{display:block}
.rate{display:flex;align-items:center;gap:10px}.rate b{font-size:26px;font-variant-numeric:tabular-nums;min-width:3.2em}
.bar{flex:1;height:10px;background:var(--line);border-radius:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--muted)}
.good .bar i{background:var(--good)}.even .bar i{background:var(--even)}.bad .bar i{background:var(--bad)}
.rate small{color:var(--muted);font-size:12px;white-space:nowrap}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13.5px}dt{color:var(--muted)}dd{margin:0}
.guess{font-size:11.5px;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:0 6px;white-space:nowrap}
footer{font-size:11.5px;color:var(--muted);line-height:1.6}
</style></head><body><main>
<div><h1>${esc(r.teamName)} × M-C上位構築</h1><p class="sub">${esc(r.date)} ／ レギュレーション ${esc(r.regulation)} ／ ${battles.toLocaleString()}戦のシミュレーション</p></div>
<div class="mine">自分: <b>${r.mine.map(nm).join("・")}</b></div>
<section class="summary"><div><b>${pct(avg)}</b><span>平均の期待勝率</span></div><div><b>${wins}/${rows.length}</b><span>勝率50%以上</span></div><div><b>${rows[0] ? pct(rows[0].winRate) : "-"}</b><span>一番苦手</span></div></section>
${cards}
<footer>苦手な順に並べています。期待勝率＝相手も最善の選出をする前提で、選出をうまく混ぜたときの勝率。最低＝相手がどの選出でも取れる勝率。<br>相手のポケモン・持ち物は pokedb 上位構築データ、技・特性・性格・SPは ${esc(r.usageSource)} の最多の型による推定。両者とも同じ確率的なAIで行動（推測を含む）。</footer>
</main></body></html>`;
}
