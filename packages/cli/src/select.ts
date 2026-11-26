// `sim:select <自分.txt> <相手.txt|pokedb:…>`: a selection that holds up against counter-picks
// (the opponent keeps all of its brings), as text and as a phone page.
import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";
import { parseShowdown } from "@ca/ingest";
import {
  analyzeSelectionRobust,
  searchBudgetFrom,
  simContext,
  type Executor,
  type RobustSelection,
} from "@ca/sim";
import type { Io } from "./commands.js";
import type { SimEnv } from "./sim-commands.js";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const nm = (id: string) => displayName("species", id);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const bt = (b: string[]) =>
  `${b.slice(0, 2).map(nm).join("・")} ／ 後ろ ${b.slice(2).map(nm).join("・")}`;
const pm = (r: { rate: number; games: number }) =>
  `±${Math.round(196 * Math.sqrt((r.rate * (1 - r.rate)) / Math.max(1, r.games)))}`;

/** Probability that the opponent brings / leads each of its Pokémon under a mixed strategy. */
export function speciesOdds(
  r: RobustSelection,
  weights: number[],
  cols: number[],
): { species: string; bring: number; lead: number }[] {
  const out = new Map<string, { bring: number; lead: number }>();
  cols.forEach((j, y) => {
    const w = weights[y] ?? 0;
    r.theirs[j]!.species.forEach((s, k) => {
      const e = out.get(s) ?? { bring: 0, lead: 0 };
      e.bring += w;
      if (k < 2) e.lead += w;
      out.set(s, e);
    });
  });
  return [...out.entries()]
    .map(([species, v]) => ({ species, ...v }))
    .sort((a, b) => b.bring - a.bring || a.species.localeCompare(b.species));
}

/** My win rate (policy games, every opposing bring weighted equally) split by whether the
 *  opponent brings / leads each of its Pokémon. */
export function presenceSplit(r: RobustSelection, i: number) {
  const species = [...new Set(r.theirs.flatMap((t) => t.species))];
  const avg = (js: number[]) =>
    js.length ? js.reduce((a, j) => a + r.mc[i]![j]!.rate, 0) / js.length : NaN;
  return species.map((s) => {
    const all = r.theirs.map((_, j) => j);
    const has = all.filter((j) => r.theirs[j]!.species.includes(s));
    const lead = all.filter((j) => r.theirs[j]!.species.slice(0, 2).includes(s));
    return {
      species: s,
      brought: avg(has),
      notBrought: avg(all.filter((j) => !has.includes(j))),
      leads: avg(lead),
      notLead: avg(all.filter((j) => !lead.includes(j))),
    };
  });
}

export function renderSelection(r: RobustSelection, title: string, method: string): string {
  const all = r.theirs.map((_, j) => j);
  const best = r.searchEq.mine.indexOf(Math.max(...r.searchEq.mine));
  const rowOf = (x: number) => r.mine[r.rows[x]!]!.species;
  const colOf = (y: number) => r.theirs[r.cols[y]!]!.species;
  const odds = speciesOdds(r, r.mcEq.theirs, all);
  const oddsSearch = speciesOdds(r, r.searchEq.theirs, r.cols);
  const sorted = r.cols
    .map((_, y) => y)
    .sort((a, b) => r.searchEq.theirs[b]! - r.searchEq.theirs[a]!);
  const cards = r.rows
    .map((i, x) => {
      const line = r.search[x]!;
      const v = line.reduce((a, c, y) => a + c.rate * r.searchEq.theirs[y]!, 0);
      const worst = line.map((c, y) => ({ c, y })).sort((a, b) => a.c.rate - b.c.rate)[0]!;
      const mcWorst = r.mc[i]!.map((c, j) => ({ c, j }))
        .sort((a, b) => a.c.rate - b.c.rate)
        .slice(0, 5);
      return `<section class="card${x === best ? " best" : ""}">
<h2>${esc(bt(rowOf(x)))}${x === best ? '<span class="tag">推奨</span>' : ""}${x === r.safest.row ? '<span class="tag">安全策</span>' : ""}</h2>
<dl class="kv"><dt>読み合いでの採用割合</dt><dd>${pct(r.searchEq.mine[x]!)}</dd>
<dt>相手が最適に選んだときの勝率</dt><dd>${pct(v)}</dd>
<dt>一番痛い相手の選出</dt><dd>${esc(bt(colOf(worst.y)))}：${pct(worst.c.rate)}</dd></dl>
<div class="scroll"><table><thead><tr><th>相手の選出</th><th>相手が選ぶ割合</th><th>探索あり</th><th>方針のみ</th></tr></thead><tbody>
${sorted
  .map((y) => {
    const c = line[y]!;
    const m = r.mc[i]![r.cols[y]!]!;
    return `<tr><th>${esc(bt(colOf(y)))}</th><td class="c">${pct(r.searchEq.theirs[y]!)}</td><td class="c ${c.rate < 0.4 ? "bad" : c.rate >= 0.6 ? "good" : ""}">${pct(c.rate)}<br><span class="muted">${pm(c)}・${c.games}戦</span></td><td class="c">${pct(m.rate)}<br><span class="muted">${m.games}戦</span></td></tr>`;
  })
  .join("")}
</tbody></table></div>
<details><summary>相手が各ポケモンを出す／出さないときの勝率（方針のみ・全選出の平均）</summary><div class="scroll"><table><thead><tr><th>相手のポケモン</th><th>選出あり</th><th>選出なし</th><th>先発</th><th>先発でない</th></tr></thead><tbody>${presenceSplit(
        r,
        i,
      )
        .map(
          (p) =>
            `<tr><th>${esc(nm(p.species))}</th><td class="c">${pct(p.brought)}</td><td class="c">${pct(p.notBrought)}</td><td class="c">${pct(p.leads)}</td><td class="c">${pct(p.notLead)}</td></tr>`,
        )
        .join("")}</tbody></table></div></details>
<details><summary>方針のみの対戦で一番苦しい相手の選出（全${r.theirs.length}通り中）</summary><ol class="small">${mcWorst
        .map((w) => `<li>${esc(bt(r.theirs[w.j]!.species))}：${pct(w.c.rate)}</li>`)
        .join("")}</ol></details></section>`;
    })
    .join("\n");
  const oddsTable = (xs: ReturnType<typeof speciesOdds>) =>
    `<div class="scroll"><table><thead><tr><th>相手のポケモン</th><th>選出する確率</th><th>先発の確率</th></tr></thead><tbody>${xs
      .map(
        (x) =>
          `<tr><th>${esc(nm(x.species))}</th><td class="c">${pct(x.bring)}</td><td class="c">${pct(x.lead)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  return `<title>${esc(title)}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* one column: conclusion → opponent's selection odds → one card per candidate bring */
:root{--bg:#f4f5f8;--card:#fff;--fg:#1b2130;--muted:#5f6878;--line:#dde1e8;--chip:#eef1f6;--accent:#2553c4;--good:#1d7a4b;--bad:#b42318;--font:"Hiragino Sans","Noto Sans JP",system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--chip:#252b36;--accent:#86a2ff;--good:#5fd39a;--bad:#ff7b72;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#12151c;--card:#1b2029;--fg:#e7eaf0;--muted:#9aa3b2;--line:#2d3340;--chip:#252b36;--accent:#86a2ff;--good:#5fd39a;--bad:#ff7b72;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--font)}
main{max-width:760px;margin:0 auto;padding-block:12px 48px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));display:grid;gap:10px}
h1{font-size:18px;margin:0;text-wrap:balance}h2{font-size:15px;margin:0 0 6px;text-wrap:balance}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-width:0}
.card.best{border-color:var(--accent);box-shadow:inset 4px 0 0 var(--accent)}
.tag{font-size:11px;background:var(--chip);border-radius:4px;padding:1px 6px;margin-left:6px;color:var(--muted);font-weight:600}
.muted,.small{color:var(--muted);font-size:12px}
.kv{display:grid;grid-template-columns:minmax(6em,45%) 1fr;gap:3px 12px;font-size:13px;margin:0 0 8px}.kv dt{color:var(--muted)}.kv dd{margin:0;font-weight:600}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;width:100%}
th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}thead th{background:var(--chip)}
tbody th{font-weight:500;min-width:10em}td.c{text-align:center;white-space:nowrap}
td.good{color:var(--good);font-weight:700}td.bad{color:var(--bad);font-weight:700}
details>summary{cursor:pointer;font-weight:600;margin-top:6px}
</style>
<main>
<section class="card"><h1>${esc(title)}</h1><p class="muted">${esc(method)}</p>
<dl class="kv"><dt>推奨選出</dt><dd>${esc(bt(rowOf(best)))}</dd>
<dt>相手も最適に選んだときの勝率</dt><dd>${pct(r.searchEq.value)}</dd>
<dt>安全策（最悪の相手選出でも）</dt><dd>${esc(bt(rowOf(r.safest.row)))}：最低 ${pct(r.safest.worst)}（相手 ${esc(bt(colOf(r.safest.col)))}）</dd>
<dt>対戦数</dt><dd>${r.battles}戦</dd></dl></section>
<section class="card"><h2>相手の選出の読み（相手は全${r.theirs.length}通りから選べる）</h2>
<p class="small">こちらの6体を見た相手が、こちらの選出を読んで最適に選ぶときの確率。</p>
<h2 style="font-size:13px">探索ありの対戦で絞った候補での読み</h2>${oddsTable(oddsSearch)}
<details><summary>方針のみの対戦・全選出での読み</summary>${oddsTable(odds)}</details></section>
${cards}
</main>
`;
}

export interface SelectDeps {
  executor: (
    mine: PokemonSet[],
    theirs: PokemonSet[],
  ) => Executor & { close?: () => Promise<void> };
  write: (path: string, text: string) => void;
}

const opt = (args: string[], k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

/**
 * `sim:select <自分.txt> <相手.txt|pokedb:…> [--top 8] [--screen 12] [--games 12] [--rows 4]
 *  [--counters 3] [--support 6] [--search-games 6] [--think 0.3] [--seed 1] [--out reports/select]`
 */
export async function selectCommand(
  args: string[],
  env: SimEnv,
  deps: SelectDeps,
  io: Io,
): Promise<number> {
  const pos = args.filter((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const [myFile, oppSpec] = pos;
  if (!myFile || !oppSpec) {
    io.err("usage: pnpm sim:select <自分.txt> <相手.txt|pokedb:M-7:4>");
    return 2;
  }
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  const mine = parseShowdown(env.readText(myFile), legal).members;
  const resolved = env.resolveTeam?.(oppSpec);
  const theirs = resolved ? resolved.members : parseShowdown(env.readText(oppSpec), legal).members;
  const oppName = resolved?.label ?? oppSpec.replace(/^.*\//, "").replace(/\.txt$/, "");
  const myName = myFile.replace(/^.*\//, "").replace(/\.txt$/, "");
  const ctx = simContext(env.pack, env.spec);
  const exec = deps.executor(mine, theirs);
  let r: RobustSelection;
  try {
    r = await analyzeSelectionRobust(
      ctx,
      mine,
      theirs,
      exec,
      {
        myTop: Number(opt(args, "top", "8")),
        screenGames: Number(opt(args, "screen", "12")),
        games: Number(opt(args, "games", "12")),
        rows: Number(opt(args, "rows", "4")),
        counters: Number(opt(args, "counters", "3")),
        support: Number(opt(args, "support", "6")),
        searchGames: Number(opt(args, "search-games", "6")),
        search: searchBudgetFrom(ctx.params, Number(opt(args, "think", "0.3"))),
        iterations: 20000,
      },
      Number(opt(args, "seed", "1")),
      (st, n) => io.err(`… ${st}: ${n}戦`),
    );
  } finally {
    await exec.close?.();
  }
  const best = r.searchEq.mine.indexOf(Math.max(...r.searchEq.mine));
  io.out(
    `${myName} vs ${oppName}: 相手は全${r.theirs.length}通りの選出から選べる前提（${r.battles}戦）`,
  );
  io.out(
    `推奨: ${bt(r.mine[r.rows[best]!]!.species)}（相手も最適に選んだときの勝率 ${pct(r.searchEq.value)}）`,
  );
  io.out(
    `安全策: ${bt(r.mine[r.rows[r.safest.row]!]!.species)}（最悪 ${pct(r.safest.worst)}：相手 ${bt(r.theirs[r.cols[r.safest.col]!]!.species)}）`,
  );
  io.out("相手のポケモンを選出する確率（探索ありの読み）:");
  for (const x of speciesOdds(r, r.searchEq.theirs, r.cols))
    io.out(`  ${nm(x.species)}: 選出 ${pct(x.bring)}、先発 ${pct(x.lead)}`);
  r.rows.forEach((i, x) => {
    const line = r.search[x]!;
    const w = line.map((c, y) => ({ c, y })).sort((a, b) => a.c.rate - b.c.rate)[0]!;
    io.out(
      `  ${bt(r.mine[i]!.species)}: 採用 ${pct(r.searchEq.mine[x]!)}、最悪 ${pct(w.c.rate)}（相手 ${bt(r.theirs[r.cols[w.y]!]!.species)}）`,
    );
  });
  io.out("相手が各ポケモンを出す／出さないときの、推奨選出の勝率（方針のみ・全選出の平均）:");
  for (const p of presenceSplit(r, r.rows[best]!))
    io.out(
      `  ${nm(p.species)}: 選出あり ${pct(p.brought)} ／ なし ${pct(p.notBrought)}、先発 ${pct(p.leads)} ／ 先発でない ${pct(p.notLead)}`,
    );
  const title = `${myName} vs ${oppName} 選出の検証`;
  const out = `${opt(args, "out", "reports/select")}/${myName}--${oppName.replace(/[^A-Za-z0-9-]+/g, "_")}.html`;
  deps.write(
    out,
    renderSelection(
      r,
      title,
      `相手はこちらの6体を見て全${r.theirs.length}通りの選出から選べる前提。こちらの有力な選出${r.mine.length}通り×相手の全選出を方針どうしで各${opt(args, "games", "12")}戦し、読み合いを解いたうえで、相手の有力な選出とこちらの各選出への一番痛い選出（カウンター）を両者が毎ターン探索する対戦で各${opt(args, "search-games", "6")}戦して確かめた。`,
    ),
  );
  io.out(out);
  return 0;
}
