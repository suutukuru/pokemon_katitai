// `report:pairbook`: every game of one pair against many opposing pairs, with what the engine
// considered at each turn (its candidates, its prediction of the opponent, the payoff matrix),
// as one self-contained browser page (also emitted in Artifact form).
import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";
import type { ReplayData, WhatIfOption } from "@ca/sim";

export interface PairBookMatch {
  opp: [string, string];
  /** how often this pair appears together (relative; usage × teammate share) */
  weight: number;
  /** listed because the user asked for it rather than by frequency */
  extra: boolean;
  games: ReplayData[];
}

export interface PairBookInput {
  title: string;
  mine: PokemonSet[];
  opponents: Record<string, PokemonSet[]>;
  matches: PairBookMatch[];
  method: string;
  source: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function names(input: PairBookInput): Record<string, string> {
  const sp = new Set<string>();
  const mv = new Set<string>();
  const it = new Set<string>();
  const ab = new Set<string>();
  const addSet = (s: PokemonSet) => {
    sp.add(s.species);
    s.moves.forEach((m) => mv.add(m));
    if (s.item) it.add(s.item);
    ab.add(s.ability);
  };
  input.mine.forEach(addSet);
  Object.values(input.opponents).forEach((t) => t.forEach(addSet));
  for (const m of input.matches)
    for (const g of m.games)
      for (const t of g.turns) {
        for (const e of t.events) {
          if ("who" in e) sp.add(e.who);
          if (e.t === "move") mv.add(e.move);
          if ((e.t === "damage" || e.t === "heal") && e.from) it.add(e.from);
        }
        for (const o of [...(t.plan?.mine ?? []), ...(t.plan?.opp ?? []), ...(t.whatIfOpp ?? [])])
          for (const s of o.slots) {
            if (s.species) sp.add(s.species);
            if (s.moveId) mv.add(s.moveId);
            if (s.targetSpecies) sp.add(s.targetSpecies);
            if (s.switchTo) sp.add(s.switchTo);
          }
        for (const b of t.plan?.board ?? []) sp.add(b.species);
      }
  const out: Record<string, string> = {};
  sp.forEach((id) => (out[`s:${id}`] = displayName("species", id)));
  mv.forEach((id) => (out[`m:${id}`] = displayName("moves", id)));
  it.forEach((id) => {
    const n = displayName("items", id);
    out[`i:${id}`] = n !== id ? n : displayName("abilities", id);
  });
  ab.forEach((id) => (out[`a:${id}`] = displayName("abilities", id)));
  return out;
}

const r3 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 1000) / 1000);
/** Options as the page needs them (no confidence intervals, rounded numbers, no empty fields). */
function opts(xs: WhatIfOption[]) {
  return xs.map((o) => ({
    choice: o.choice,
    slots: o.slots.map((sl) =>
      Object.fromEntries(Object.entries(sl).filter(([, v]) => v !== "" && v !== false)),
    ),
    winRate: r3(o.winRate),
    ...(o.prob ? { prob: r3(o.prob) } : {}),
    ...(o.chosen ? { chosen: true } : {}),
    ...(o.inMatrix ? { inMatrix: true } : {}),
  }));
}

/** Strip what the page does not use (keeps the payload small). */
function slim(g: ReplayData) {
  return {
    r: g.result,
    turns: g.turns.map((t) => ({
      turn: t.turn,
      events: t.events,
      eval: t.eval,
      ...(t.plan ? { plan: { ...t.plan, mine: opts(t.plan.mine), opp: opts(t.plan.opp) } } : {}),
      opp: (t.whatIfOpp ?? []).filter((o) => o.chosen).map((o) => o.slots),
    })),
    reviews: (g.reviews ?? []).filter((r) => r.side === 0),
  };
}

export function renderPairBook(input: PairBookInput): string {
  const payload = JSON.stringify({
    title: input.title,
    method: input.method,
    source: input.source,
    mine: input.mine,
    opponents: input.opponents,
    matches: input.matches.map((m) => ({ ...m, games: m.games.map(slim) })),
    n: names(input),
  }).replace(/</g, "\\u003c");
  return `<title>${esc(input.title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* layout: one column, a list of matchups → a matchup page with its games (hash routing) */
:root{--bg:#f4f5f8;--card:#fff;--fg:#1b2130;--muted:#5f6878;--line:#dde1e8;--chip:#eef1f6;--me:#2553c4;--op:#b13c1a;--good:#1d7a4b;--mid:#8a6100;--bad:#b42318;--accent:#2553c4;--hl:#fff3c4;
--font:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif;--mono:ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--chip:#252b36;--me:#86a2ff;--op:#ff9b7d;--good:#5fd39a;--mid:#f0b443;--bad:#ff7b72;--accent:#86a2ff;--hl:#3a3420;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--chip:#252b36;--me:#86a2ff;--op:#ff9b7d;--good:#5fd39a;--mid:#f0b443;--bad:#ff7b72;--accent:#86a2ff;--hl:#3a3420;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font)}
main{max-width:760px;margin:0 auto;padding-block:12px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:10px}
h1{font-size:18px;margin:0;text-wrap:balance}h2{font-size:15px;margin:0 0 6px}h3{font-size:14px;margin:0}
.sub,.muted{color:var(--muted);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input[type=search]{flex:1 1 180px;min-width:0;font:inherit;font-size:16px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
button{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-height:36px;cursor:pointer}
button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.list{display:grid;gap:6px}
.row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;text-align:left;width:100%;padding:9px 10px}
.row .nm{font-weight:700}.row .meta{grid-column:1/3;color:var(--muted);font-size:12px}
.rate{font-weight:800;font-variant-numeric:tabular-nums;padding:2px 8px;border-radius:999px;background:var(--chip)}
.rate.good{color:var(--good)}.rate.mid{color:var(--mid)}.rate.bad{color:var(--bad)}
.freq{display:inline-block;height:6px;background:var(--accent);opacity:.5;border-radius:3px;vertical-align:middle;margin-right:6px}
.tag{font-size:11px;background:var(--chip);border-radius:4px;padding:1px 6px;margin-left:6px;color:var(--muted)}
.sets{display:grid;gap:4px;font-size:12px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:13px}.kv dt{color:var(--muted)}.kv dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:3px 5px;text-align:left;vertical-align:top}
th{background:var(--chip);font-weight:600}
td.c{text-align:center;min-width:44px}
table.mx th{min-width:9.5em;font-weight:500;line-height:1.35}
table.mx thead th:first-child{min-width:8em}
table.mx{width:max-content}
table.mx tbody th,table.mx thead th:first-child{position:sticky;left:0;z-index:1;background:var(--card);min-width:9em;max-width:11em}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
tr.chosen th,tr.chosen td:first-child{box-shadow:inset 3px 0 0 var(--me)}
td.actual,th.actual{outline:2px solid var(--op);outline-offset:-2px}
.game{border-top:1px dashed var(--line);padding-top:8px;margin-top:8px}
details>summary{cursor:pointer;font-weight:600;padding:4px 0}
.turn{border-left:3px solid var(--line);padding-left:10px;margin:10px 0;display:grid;gap:6px;min-width:0}
.turn>*,details,section>*{min-width:0}
.board{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:12px}
.mon{display:grid;grid-template-columns:1fr auto;gap:0 6px;align-items:center}
.mon .bar{grid-column:1/3;height:5px;background:var(--chip);border-radius:3px;overflow:hidden}
.mon .bar i{display:block;height:100%;background:var(--good)}
.mon.me .n{color:var(--me)}.mon.op .n{color:var(--op)}.mon.out{opacity:.55}
.acts{font-size:13px}.acts b{font-weight:700}
.ev{font-size:12px;color:var(--muted);margin:0;padding-left:16px}
.opts{display:grid;gap:3px;font-size:12px}
.opt{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:baseline}
.opt.chosen{font-weight:700}.opt.out{color:var(--muted)}
.num{font-variant-numeric:tabular-nums}
a{color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
<main id="app"></main>
<script id="payload" type="application/json">${payload}</script>
<script>
(function(){
const D=JSON.parse(document.getElementById("payload").textContent);
const N=D.n;const sp=id=>N["s:"+id]||id;const mv=id=>N["m:"+id]||id;const it=id=>id?(N["i:"+id]||id):"";const ab=id=>N["a:"+id]||id;
const pct=x=>Math.round(x*100)+"%";
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const tone=x=>x>=0.6?"good":x<=0.4?"bad":"mid";
const INT={P:"まもる系",S:"全体攻撃",X:"補助技"};
function slot(s,withWho){const who=withWho&&s.species?sp(s.species)+": ":"";
 if(s.intent&&!s.intent.startsWith("M:")){const t=s.targetSpecies?" → "+sp(s.targetSpecies):"";
  if(s.intent[0]==="A")return who+"一番強い攻撃"+t;if(s.intent[0]==="F")return who+"ねこだまし"+t;
  if(s.intent[0]==="W")return who+(s.switchTo?sp(s.switchTo)+"に交代":"交代");return who+(INT[s.intent]||s.intent);}
 if(s.switchTo)return who+sp(s.switchTo)+"に交代";if(!s.moveId)return who+"—";
 return who+(s.mega?"メガ＋":"")+mv(s.moveId)+(s.targetSpecies?" → "+sp(s.targetSpecies):"");}
const optText=o=>o.slots.filter(s=>s.species||s.switchTo).map(s=>slot(s,true)).join(" ／ ");
const optHtml=o=>o.slots.filter(s=>s.species||s.switchTo).map(s=>esc(slot(s,true))).join("<br>");
function evText(e){const S=x=>x===0?"":"相手の";
 switch(e.t){case"switch":return S(e.side)+sp(e.who)+" が出てきた";
 case"move":return S(e.side)+sp(e.who)+" の "+mv(e.move)+(e.target&&!e.spread&&!(e.target.side===e.side&&e.target.who===e.who)?"（→ "+S(e.target.side)+sp(e.target.who)+"）":"");
 case"damage":return "\\u3000"+S(e.side)+sp(e.who)+" 残り "+e.hp+"%"+(e.from?"（"+it(e.from)+"）":"");
 case"heal":return "\\u3000"+S(e.side)+sp(e.who)+" 回復 "+e.hp+"%";case"faint":return "\\u3000"+S(e.side)+sp(e.who)+" たおれた";
 case"crit":return "\\u3000急所";case"super":return "\\u3000効果はばつぐん";case"resisted":return "\\u3000いまひとつ";case"immune":return "\\u3000効果なし";
 case"miss":return "\\u3000外れた";case"protected":return "\\u3000"+S(e.side)+sp(e.who)+" は守った";case"mega":return S(e.side)+sp(e.who)+" メガシンカ";
 case"boost":return "\\u3000"+S(e.side)+sp(e.who)+" "+e.stat+(e.n>0?" +":" ")+e.n;case"status":return "\\u3000"+S(e.side)+sp(e.who)+" "+e.status;
 case"cant":return "\\u3000"+S(e.side)+sp(e.who)+" 動けない";case"weather":return e.upkeep?null:"天気: "+e.weather;
 case"sidestart":return (e.side?"相手":"自分")+"の場: "+e.cond;case"fieldstart":return "場: "+e.cond;default:return null;}}
const label=ids=>ids.map(sp).join("＋");
const stats=m=>{let w=0,n=m.games.length;m.games.forEach(g=>{w+=g.r.winner===0?1:g.r.winner===null?0.5:0});return{w,n,rate:n?w/n:0,turns:n?m.games.reduce((a,g)=>a+g.r.turns,0)/n:0}};
const totalW=D.matches.filter(m=>!m.extra).reduce((a,m)=>a+m.weight,0)||1;
let sort="freq",q="";
function setLine(s){return '<div><b>'+esc(sp(s.species))+'</b> @ '+esc(it(s.item))+' / '+esc(ab(s.ability))+' / '+esc(s.nature)+' — '+s.moves.map(m=>esc(mv(m))).join("・")+'</div>'}
function overview(){
 const ms=D.matches.map((m,i)=>({m,i,s:stats(m)})).filter(x=>!q||label(x.m.opp).includes(q)||x.m.opp.some(id=>id.includes(q.toLowerCase())));
 ms.sort((a,b)=>sort==="rate"?a.s.rate-b.s.rate:sort==="rateDesc"?b.s.rate-a.s.rate:(b.m.weight-a.m.weight)||(a.i-b.i));
 const all=D.matches.reduce((a,m)=>{const s=stats(m);return{w:a.w+s.w,n:a.n+s.n,ws:a.ws+(m.extra?0:s.rate*m.weight)}},{w:0,n:0,ws:0});
 return '<section class="card"><h1>'+esc(D.title)+'</h1><p class="sub">'+esc(D.method)+'</p>'+
 '<dl class="kv"><dt>対面</dt><dd>'+D.matches.length+'組（そのうち指定 '+D.matches.filter(m=>m.extra).length+'組）</dd><dt>対戦</dt><dd>'+all.n+'戦・'+all.w+'勝</dd><dt>頻度で重み付けした勝率</dt><dd>'+pct(all.ws/totalW)+'</dd></dl>'+
 '<details><summary>使った型</summary><div class="sets">'+D.mine.map(setLine).join("")+'</div></details><p class="muted">出典: '+esc(D.source)+'</p></section>'+
 '<section class="card"><div class="controls"><input type="search" id="q" placeholder="ポケモン名で絞り込み（例: ブリジュラス）" value="'+esc(q)+'" aria-label="相手のポケモン名で絞り込み">'+
 '<button data-sort="freq" class="'+(sort==="freq"?"on":"")+'">よく見る順</button><button data-sort="rate" class="'+(sort==="rate"?"on":"")+'">苦手順</button><button data-sort="rateDesc" class="'+(sort==="rateDesc"?"on":"")+'">得意順</button></div></section>'+
 '<section class="list" aria-label="相手の並び">'+ms.map(({m,i,s})=>'<button class="row card" data-go="'+i+'"><span class="nm">'+esc(label(m.opp))+(m.extra?'<span class="tag">指定</span>':'')+'</span><span class="rate '+tone(s.rate)+'">'+pct(s.rate)+'</span><span class="meta">'+(m.extra?'':'<span class="freq" style="width:'+Math.max(4,Math.round(m.weight/totalW*600))+'px"></span>出現頻度 '+(m.weight/totalW*100).toFixed(1)+'% ・ ')+s.n+'戦 '+s.w+'勝 ・ 平均 '+s.turns.toFixed(1)+'ターン</span></button>').join("")+'</section>';}
function board(b){const side=x=>b.filter(m=>m.side===x).map(m=>'<div class="mon '+(x?"op":"me")+(m.status==="fnt"?" out":"")+'"><span class="n">'+esc(sp(m.species))+(m.active?"":"（控え）")+'</span><span class="num">'+(m.status==="fnt"?"×":m.hp+"%")+'</span><span class="bar"><i style="width:'+(m.status==="fnt"?0:m.hp)+'%"></i></span></div>').join("");
 return '<div class="board"><div>'+side(0)+'</div><div>'+side(1)+'</div></div>'}
function matrix(p,review){if(!p.matrix.length)return"";
 const mine=p.rows.map(c=>p.mine.find(o=>o.choice===c));const opp=p.cols.map(c=>p.opp.find(o=>o.choice===c));
 const chosen=p.mine.find(o=>o.chosen);const act=review&&review.actualColumn>=0?review.actualColumn:-1;
 let h='<div class="scroll"><table class="mx"><thead><tr><th>自分 ＼ 相手（予測の割合）</th>'+opp.map((o,j)=>'<th class="'+(j===act?"actual":"")+'" title="相手">'+(o?optHtml(o):"—")+'<br><span class="muted">'+(o&&o.prob!=null?pct(o.prob):"")+'</span></th>').join("")+'<th>平均</th></tr></thead><tbody>';
 p.matrix.forEach((r,i)=>{const o=mine[i];const isC=o&&chosen&&o.choice===chosen.choice;
  h+='<tr class="'+(isC?"chosen":"")+'"><th>'+(o?optHtml(o):"—")+'<br><span class="muted">推奨 '+(o&&o.prob!=null?pct(o.prob):"")+'</span></th>'+r.map((v,j)=>'<td class="c '+(j===act?"actual":"")+'" style="background:color-mix(in srgb,'+(v>=0.5?"var(--good)":"var(--bad)")+' '+Math.round(Math.abs(v-0.5)*120)+'%,transparent)">'+pct(v)+'</td>').join("")+'<td class="c"><b>'+(o?pct(o.winRate):"")+'</b></td></tr>'});
 return h+'</tbody></table></div>'}
function turnView(t,g){const p=t.plan;const rv=g.reviews.find(r=>r.turn===t.turn);let h='<div class="turn"><h3>'+(t.turn===0?'登場':t.turn+'ターン目')+(t.eval!=null?' <span class="muted">決めたときの勝率 '+pct(t.eval)+'</span>':'')+'</h3>';
 if(p){h+=board(p.board);const ch=p.mine.find(o=>o.chosen);
  h+='<div class="acts">自分: <b>'+(ch?esc(optText(ch)):"—")+'</b><br>相手（実際）: <b>'+(t.opp.length?esc(t.opp[0].filter(s=>s.species||s.switchTo).map(s=>slot(s,true)).join(" ／ ")):"—")+'</b>'+(rv&&rv.predictedProb!=null&&rv.actualColumn>=0?' <span class="muted">（予測していた割合 '+pct(rv.predictedProb)+'）</span>':rv&&rv.opponentActed?' <span class="muted">（予測の候補外）</span>':'')+'</div>';
  h+='<details><summary>想定したパターン: 自分 '+p.rows.length+'通り × 相手 '+p.cols.length+'通り（ありうる世界 '+p.worlds+'通り・'+p.rollouts+'戦）</summary>'+matrix(p,rv)+
  '<p class="muted">行＝自分の候補、列＝相手の行動の予測（相手の見せていない技は「一番強い攻撃」などの意図で表す）。マス＝その組み合わせを最後まで対戦させた勝率。枠線の列＝相手が実際に取った行動。</p>'+
  '<details><summary>絞り込みで外れた候補も含む全 '+p.mine.length+' 通り</summary><div class="opts">'+p.mine.map(o=>'<div class="opt '+(o.chosen?"chosen":"")+(o.inMatrix?"":" out")+'"><span>'+esc(optText(o))+'</span><span class="num">'+pct(o.winRate)+'</span><span class="num muted">'+(o.inMatrix?"推奨 "+pct(o.prob||0):"除外")+'</span></div>').join("")+'</div></details></details>';
  if(rv&&rv.bestVsActual!=null)h+='<div class="muted">振り返り: 相手の実際の行動に対し '+(rv.regret>0.005?'最善は '+esc((rv.labels&&rv.labels.best?rv.labels.best.filter(s=>s.species).map(s=>slot(s,true)).join(" ／ "):rv.bestChoice))+'（'+pct(rv.vsActual||0)+' → '+pct(rv.bestVsActual)+'）':'選んだ手が最善（'+pct(rv.vsActual||rv.bestVsActual)+'）')+'</div>';}
 const ev=t.events.map(evText).filter(Boolean);if(ev.length)h+='<details><summary>このターンの出来事</summary><ul class="ev">'+ev.map(x=>'<li>'+esc(x)+'</li>').join("")+'</ul></details>';
 return h+'</div>'}
function summary(m){const agg=new Map(),oppAgg=new Map();let games=0;
 m.games.forEach(g=>{const t=g.turns.find(x=>x.plan);if(!t)return;games++;
  t.plan.mine.forEach(o=>{const k=optText(o);const a=agg.get(k)||{n:0,v:0,chosen:0,wins:0};a.n++;a.v+=o.winRate;if(o.chosen){a.chosen++;if(g.r.winner===0)a.wins++}agg.set(k,a)});
  t.plan.opp.forEach(o=>{if(!o.inMatrix)return;const k=optText(o);const a=oppAgg.get(k)||{n:0,p:0};a.n++;a.p+=o.prob||0;oppAgg.set(k,a)})});
 const rows=[...agg].sort((a,b)=>b[1].chosen-a[1].chosen||b[1].v/b[1].n-a[1].v/a[1].n).slice(0,12);
 const orows=[...oppAgg].sort((a,b)=>b[1].p-a[1].p).slice(0,10);
 return '<h2>1ターン目に想定したこと（'+games+'戦分）</h2><div class="scroll"><table><thead><tr><th>自分の候補</th><th>評価した回数</th><th>平均勝率</th><th>選んだ回数（勝ち）</th></tr></thead><tbody>'+
 rows.map(([k,a])=>'<tr><td>'+esc(k)+'</td><td class="c">'+a.n+'</td><td class="c">'+pct(a.v/a.n)+'</td><td class="c">'+a.chosen+(a.chosen?'（'+a.wins+'）':'')+'</td></tr>').join("")+'</tbody></table></div>'+
 '<div class="scroll" style="margin-top:8px"><table><thead><tr><th>予測した相手の行動</th><th>平均の予測割合</th></tr></thead><tbody>'+orows.map(([k,a])=>'<tr><td>'+esc(k)+'</td><td class="c">'+pct(a.p/games)+'</td></tr>').join("")+'</tbody></table></div>'}
function detail(i){const m=D.matches[i];const s=stats(m);const opp=D.opponents[m.opp.join("+")]||[];
 let h='<p><a href="#" data-back>← 一覧に戻る</a></p><section class="card"><h1>vs '+esc(label(m.opp))+'</h1><dl class="kv"><dt>結果</dt><dd>'+s.n+'戦 '+s.w+'勝（'+pct(s.rate)+'）</dd><dt>平均ターン</dt><dd>'+s.turns.toFixed(1)+'</dd>'+(m.extra?'':'<dt>出現頻度</dt><dd>'+(m.weight/totalW*100).toFixed(1)+'%</dd>')+'</dl>'+
 '<details><summary>相手の型（使用率から推定）</summary><div class="sets">'+opp.map(setLine).join("")+'</div></details></section>';
 h+='<section class="card">'+summary(m)+'</section>';
 m.games.forEach((g,gi)=>{h+='<section class="card"><details'+(gi===0?' open':'')+'><summary>'+(gi+1)+'戦目: '+(g.r.winner===0?'勝ち':g.r.winner===1?'負け':'引き分け')+'（'+g.r.turns+'ターン、残り '+g.r.remaining[0]+'対'+g.r.remaining[1]+'）</summary>'+g.turns.filter(t=>t.plan||t.events.length).map(t=>turnView(t,g)).join("")+'</details></section>'});
 return h}
const app=document.getElementById("app");
function render(){const m=/^#m(\\d+)$/.exec(location.hash);app.innerHTML=m&&D.matches[+m[1]]?detail(+m[1]):overview();
 const qi=document.getElementById("q");if(qi){qi.oninput=e=>{q=e.target.value.trim();const pos=qi.selectionStart;render();const n=document.getElementById("q");n.focus();n.setSelectionRange(pos,pos)}}
 app.querySelectorAll("[data-sort]").forEach(b=>b.onclick=()=>{sort=b.dataset.sort;render()});
 app.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>{location.hash="m"+b.dataset.go;window.scrollTo(0,0)});
 app.querySelectorAll("[data-back]").forEach(a=>a.onclick=e=>{e.preventDefault();history.length>1&&location.hash?history.back():(location.hash="");});}
window.addEventListener("hashchange",render);render();
})();
</script>
`;
}
