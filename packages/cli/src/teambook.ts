// `report:teambook <自分.txt> <相手.txt|pokedb:M-7:4>`: how a team plays one opponent in 4-vs-4 —
// the selection read-off (my brings × their brings), then games of my recommended bring against
// each of the opponent's likely brings, with every turn's considered patterns (pairbook viewer).
import type { PokemonSet } from "@ca/schema";
import { displayName } from "@ca/data";
import { parseShowdown } from "@ca/ingest";
import {
  analyzeMatchup,
  mixSeed,
  searchBudgetFrom,
  simContext,
  type Config,
  type Executor,
  type ReplayData,
} from "@ca/sim";
import type { Io } from "./commands.js";
import { renderPairBook } from "./pairbook.js";
import { budgetWithOverrides, type SimEnv } from "./sim-commands.js";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const nm = (id: string) => displayName("species", id);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const bringText = (b: string[]) =>
  `${b.slice(0, 2).map(nm).join("・")} ／ 後ろ ${b.slice(2).map(nm).join("・")}`;

export interface TeamBookDeps {
  executor: (
    mine: PokemonSet[],
    theirs: PokemonSet[],
  ) => Executor & { close?: () => Promise<void> };
  play: (
    tasks: {
      mine: PokemonSet[];
      theirs: PokemonSet[];
      ca: Config;
      cb: Config;
      seed: number;
      budget: ReturnType<typeof searchBudgetFrom>;
    }[],
    onDone: (done: number) => void,
  ) => Promise<ReplayData[]>;
  write: (path: string, text: string) => void;
}

const opt = (args: string[], k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};

/** `report:teambook <自分.txt> <相手.txt|pokedb:…> [--brings 3] [--games 6] [--scale 0.4] [--think 0.6]` */
export async function teamBookCommand(
  args: string[],
  env: SimEnv,
  deps: TeamBookDeps,
  io: Io,
): Promise<number> {
  const pos = args.filter((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const [myFile, oppSpec] = pos;
  if (!myFile || !oppSpec) {
    io.err(
      "usage: pnpm report:teambook <自分.txt> <相手.txt|pokedb:M-7:4> [--brings 3] [--games 6]",
    );
    return 2;
  }
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
  const mine = parseShowdown(env.readText(myFile), legal).members;
  const resolved = env.resolveTeam?.(oppSpec);
  const theirs = resolved ? resolved.members : parseShowdown(env.readText(oppSpec), legal).members;
  const oppName = resolved?.label ?? oppSpec.replace(/^.*\//, "").replace(/\.txt$/, "");
  const myName = myFile.replace(/^.*\//, "").replace(/\.txt$/, "");
  const ctx = simContext(env.pack, env.spec);
  const seed = Number(opt(args, "seed", "1"));

  // 1) selection read-off (incl. the search-vs-search stage)
  const exec = deps.executor(mine, theirs);
  io.err(`選出の読み合い: ${myName} vs ${oppName}`);
  const a = await analyzeMatchup(
    ctx,
    mine,
    theirs,
    exec,
    budgetWithOverrides(ctx.params, Number(opt(args, "scale", "0.4")), args),
    seed,
    (st, _d, n) => io.err(`  ${st}: ${n}戦`),
  );
  await exec.close?.();
  const src = a.strong ?? a.matrix;
  const eq = a.strong ? a.strong.equilibrium : a.equilibrium;
  const best = eq.mine.indexOf(Math.max(...eq.mine));
  const myBring = src.mine[best]!;
  const theirOrder = eq.theirs
    .map((p, j) => ({ p, j }))
    .sort((x, y) => y.p - x.p || x.j - y.j)
    .slice(0, Number(opt(args, "brings", "3")));
  const toCfg = (team: PokemonSet[], b: string[]) =>
    b.map((x) => team.findIndex((m) => m.species === x)) as Config;

  // 2) games of my recommended bring against each of their likely brings
  const games = Number(opt(args, "games", "6"));
  const budget = searchBudgetFrom(ctx.params, Number(opt(args, "think", "0.6")));
  const tasks = theirOrder.flatMap(({ j }, k) =>
    Array.from({ length: games }, (_, g) => ({
      mine,
      theirs,
      ca: toCfg(mine, myBring),
      cb: toCfg(theirs, src.theirs[j]!),
      seed: mixSeed(seed, k, g),
      budget,
    })),
  );
  io.err(
    `対戦: 推奨選出 × 相手の有力な選出 ${theirOrder.length}通り × ${games}戦 = ${tasks.length}戦（両者が毎ターン探索）`,
  );
  const res = await deps.play(tasks, (d) => io.err(`  … ${d}/${tasks.length}`));

  // 3) page
  const matrix =
    `<div class="scroll"><table><thead><tr><th>自分の選出 ＼ 相手の選出</th>${src.theirs
      .map(
        (t, j) =>
          `<th>${esc(bringText(t))}<br><span class="muted">相手が選ぶ割合 ${pct(eq.theirs[j]!)}</span></th>`,
      )
      .join("")}</tr></thead><tbody>` +
    src.mine
      .map(
        (m, i) =>
          `<tr class="${i === best ? "chosen" : ""}"><th>${esc(bringText(m))}<br><span class="muted">推奨の割合 ${pct(eq.mine[i]!)}</span></th>${src.cells[
            i
          ]!.map((c) => `<td class="c">${pct(c.rate)}</td>`).join("")}</tr>`,
      )
      .join("") +
    "</tbody></table></div>";
  const intro = `<section class="card"><h2>選出の読み合い</h2>
<p>推奨選出: <b>${esc(bringText(myBring))}</b>（相手も最適に選出した場合の期待勝率 <b>${pct(eq.value)}</b>）</p>
${matrix}
<p class="muted">${a.strong ? "上位の選出同士を、両者が毎ターン探索する対戦で評価し直した表です。" : ""}マス＝その選出同士の勝率。全${a.battles}戦。下の一覧は推奨選出で、相手の有力な選出それぞれと対戦した記録です。</p></section>`;
  const html = renderPairBook({
    title: `${myName} vs ${oppName}`,
    intro,
    weightLabel: "相手の選出割合",
    mine,
    opponents: Object.fromEntries(theirOrder.map(({ j }) => [src.theirs[j]!.join("+"), theirs])),
    matches: theirOrder.map(({ j, p }, k) => ({
      opp: src.theirs[j]!,
      mine: myBring,
      weight: p,
      extra: false,
      games: res.slice(k * games, (k + 1) * games),
    })),
    method: `4対4。まず全選出の予備戦と上位の総当たり（＋両者が探索する対戦）で選出の読み合いを解き、推奨選出で相手の有力な選出と各${games}戦。両者とも毎ターン、自分から見える情報だけで候補を総当たりして読み合いを解く。`,
    source: `${env.usage?.source.title ?? ""}。相手の型: ${resolved?.note ?? oppSpec}`,
  });
  const out = `${opt(args, "out", "reports/teambook")}/${myName}--${oppName.replace(/[^A-Za-z0-9-]+/g, "_")}.html`;
  deps.write(out, html);
  io.out(out);
  const wins = res.filter((r) => r.result.winner === 0).length;
  io.out(
    `推奨選出 ${bringText(myBring)}: ${tasks.length}戦 ${wins}勝 ／ 選出の読み合いの期待勝率 ${pct(eq.value)}`,
  );
  return 0;
}
