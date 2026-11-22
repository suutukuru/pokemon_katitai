// `web:data`: run the heavy simulations once (CLI, all cores) and store the results for the web
// app, which shows them instantly on a phone and continues from them with live search.
import type { PokemonSet } from "@ca/schema";
import { canonicalJson, sha256Hex } from "@ca/data";
import { formatShowdown, parseShowdown } from "@ca/ingest";
import {
  analyzeMatchup,
  budgetFrom,
  playBestBattle,
  searchBudgetFrom,
  simContext,
  type Config,
  type MatchupAnalysis,
  type PositionAnalysis,
  type ReplayData,
  type RolloutExecutor,
  type SearchBudget,
} from "@ca/sim";
import type { Io } from "./commands.js";
import type { SimEnv } from "./sim-commands.js";

/** Stable identity of a team's sets (the web app compares it with the user's current text). */
export const teamHash = (sets: readonly PokemonSet[]) =>
  sha256Hex(canonicalJson(sets)).slice(0, 16);

export interface MetaTeamEntry {
  id: string;
  label: string;
  note?: string;
  missing?: string[];
  members: PokemonSet[];
  text: string;
}

export interface PrecomputedMatchup {
  format: "champions-analyzer.precomputed";
  version: 1;
  regulationId: string;
  dataVersion: string;
  team: { name: string; hash: string };
  opponent: { id: string; label: string; hash: string };
  seed: number;
  scale: number;
  /** screening lists trimmed to the top entries */
  analysis: MatchupAnalysis;
  /** bring used for the best-play game and the board's starting position */
  bring: { mine: Config; theirs: Config };
  best: ReplayData;
  search: SearchBudget;
  /** search results at every decision of the best-play game, by positionKey */
  positions: Record<string, PositionAnalysis>;
}

export function trimAnalysis(a: MatchupAnalysis, keep = 12): MatchupAnalysis {
  return {
    ...a,
    screening: { mine: a.screening.mine.slice(0, keep), theirs: a.screening.theirs.slice(0, keep) },
  };
}

const toConfig = (team: readonly PokemonSet[], species: string[]) =>
  species.map((x) => team.findIndex((m) => m.species === x)) as Config;

/** Recommended bring of each side: the strong stage's equilibrium if present, else the MC one. */
export function recommendedBring(
  a: MatchupAnalysis,
  mine: readonly PokemonSet[],
  theirs: readonly PokemonSet[],
): { mine: Config; theirs: Config } {
  const src = a.strong ?? a.matrix;
  const eq = a.strong ? a.strong.equilibrium : a.equilibrium;
  const top = (w: number[]) => w.indexOf(Math.max(...w));
  return {
    mine: toConfig(mine, src.mine[top(eq.mine)]!),
    theirs: toConfig(theirs, src.theirs[top(eq.theirs)]!),
  };
}

export interface WebDataDeps {
  rollouts: (workers: number) => RolloutExecutor & { close(): Promise<void> };
  write: (path: string, json: unknown) => void;
  outDir: string;
  workers: number;
}

/**
 * `web:data [--teams my-teams/a.txt,my-teams/b.txt] [--top 8] [--meta 30] [--scale 0.5]
 *  [--think 1] [--seed 1] [--workers N]`
 */
export async function webDataCommand(
  args: string[],
  env: SimEnv,
  deps: WebDataDeps,
  io: Io,
): Promise<number> {
  const opt = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? (args[i + 1] ?? d) : d;
  };
  if (!env.topTeams || !env.resolveTeam || !env.executor) {
    io.err("team database / executor is not available");
    return 1;
  }
  const top = Number(opt("top", "8"));
  const metaN = Number(opt("meta", "30"));
  const scale = Number(opt("scale", "0.5"));
  const think = Number(opt("think", "1"));
  const seed = Number(opt("seed", "1"));
  const teamFiles = opt("teams", "").split(",").filter(Boolean);
  const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };

  // 1) meta teams with estimated sets (cheap; always written)
  const meta: MetaTeamEntry[] = [];
  for (const spec of env.topTeams(metaN)) {
    const r = env.resolveTeam(spec);
    if (!r || r.members.length < env.pack.rules.bringCount) continue;
    meta.push({
      id: spec.replace(/^pokedb:/, ""),
      label: r.label,
      ...(r.note ? { note: r.note } : {}),
      ...(r.missing?.length ? { missing: r.missing } : {}),
      members: r.members,
      text: formatShowdown(r.members, "en"),
    });
  }
  deps.write(`${deps.outDir}/meta-teams.json`, {
    regulationId: env.pack.id,
    dataVersion: env.pack.dataVersion,
    teams: meta,
  });
  io.err(`meta-teams.json: ${meta.length}構築`);

  // 2) my teams × top opponents: selection analysis + best-play game + its positions
  const ctx = simContext(env.pack, env.spec);
  const budget = budgetFrom(env.pack.weights.simulation, scale);
  const search = searchBudgetFrom(env.pack.weights.simulation, think);
  const index: unknown[] = [];
  const rollouts = deps.rollouts(deps.workers);
  try {
    for (const file of teamFiles) {
      const name = file.replace(/^.*\//, "").replace(/\.txt$/, "");
      const parsed = parseShowdown(env.readText(file), legal);
      const mine = parsed.members;
      const hash = teamHash(mine);
      for (const opp of meta.slice(0, top)) {
        const t0 = Date.now();
        const exec = env.executor(mine, opp.members);
        let a: MatchupAnalysis;
        try {
          a = await analyzeMatchup(ctx, mine, opp.members, exec, budget, seed, (stage, _d, n) =>
            io.err(`  ${name} × ${opp.label}: ${stage} ${n}戦`),
          );
        } finally {
          await (exec as { close?: () => Promise<void> }).close?.();
        }
        const bring = recommendedBring(a, mine, opp.members);
        const positions: Record<string, PositionAnalysis> = {};
        const best = await playBestBattle(
          ctx,
          mine,
          opp.members,
          bring.mine,
          bring.theirs,
          seed,
          search,
          rollouts,
          (turn, an) => {
            positions[an.key] = an;
            io.err(`  ${name} × ${opp.label}: 最善手の対戦 ${turn}ターン目`);
          },
        );
        const out: PrecomputedMatchup = {
          format: "champions-analyzer.precomputed",
          version: 1,
          regulationId: env.pack.id,
          dataVersion: env.pack.dataVersion,
          team: { name, hash },
          opponent: { id: opp.id, label: opp.label, hash: teamHash(opp.members) },
          seed,
          scale,
          analysis: trimAnalysis(a),
          bring,
          best,
          search,
          positions,
        };
        const fileName = `${name}__${opp.id.replace(/[^A-Za-z0-9-]/g, "-")}.json`;
        deps.write(`${deps.outDir}/precomputed/${fileName}`, out);
        const eq = a.strong?.equilibrium ?? a.equilibrium;
        index.push({
          file: fileName,
          team: name,
          teamHash: hash,
          opponent: opp.id,
          opponentHash: teamHash(opp.members),
          label: opp.label,
          value: eq.value,
          winner: best.result.winner,
        });
        io.err(
          `${name} × ${opp.label}: 期待勝率 ${Math.round(eq.value * 100)}% / ${a.battles}戦 + 最善手対戦 ${best.rollouts}ロールアウト（${Math.round((Date.now() - t0) / 1000)}秒）`,
        );
      }
    }
  } finally {
    await rollouts.close();
  }
  if (teamFiles.length) deps.write(`${deps.outDir}/precomputed/index.json`, { entries: index });
  return 0;
}
