import type { TeamDatabaseFile } from "@ca/schema";
import { displayName, queryTeams } from "@ca/data";
import { classifyArchetypes, metaStats } from "@ca/engine";
import type { Io } from "./commands.js";

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** `meta [--from 5] [--to 7] [--top 25] [--teams]` — top-team trends from the team database. */
export function metaCommand(
  args: string[],
  files: readonly TeamDatabaseFile[],
  legalSpecies: readonly string[],
  io: Io,
  /** Default season range from the regulation pack (`manifest.seasons`). */
  seasons?: { from: number; to?: number | undefined },
): number {
  const opt = (k: string, d: number) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? Number(args[i + 1]) : d;
  };
  const from = opt("from", seasons?.from ?? 1);
  const to = opt("to", seasons?.to ?? 99);
  const top = opt("top", 25);
  const teams = queryTeams(files, { format: "doubles", seasons: [from, to], legalSpecies });
  const m = metaStats(teams);
  io.out(
    `上位構築 ${m.teams}件（${m.seasons.join(", ")}・ダブル）出典: バトルデータベース チャンピオンズ 上位構築データ`,
  );
  io.out("\n■ 採用率（上位構築に占める割合）と主な持ち物");
  for (const s of m.species.slice(0, top)) {
    const items = s.items
      .slice(0, 3)
      .map((i) => `${i.id === "(none)" ? "なし" : displayName("items", i.id)} ${i.count}`)
      .join(" / ");
    io.out(
      `  ${displayName("species", s.id).padEnd(12, "　")} ${pct(s.share).padStart(6)}  ${items}`,
    );
  }
  io.out("\n■ よく一緒に使われる2匹");
  for (const p of m.pairs.slice(0, 10))
    io.out(
      `  ${displayName("species", p.a)}＋${displayName("species", p.b)}  ${p.count}件（${pct(p.share)}）`,
    );
  io.out("\n■ 型（推測を含む）");
  for (const a of m.archetypes) io.out(`  ${a.id.padEnd(15)} ${a.count}件（${pct(a.share)}）`);
  if (args.includes("--teams")) {
    io.out("\n■ 構築一覧");
    for (const t of teams.slice(0, top)) {
      const arch = classifyArchetypes(t.members)
        .map((a) => `${a.name}${a.basis === "estimated" ? "?" : ""}`)
        .join(",");
      io.out(
        `  ${t.season} ${String(t.rank ?? "-").padStart(4)}位 ${t.rating ?? "-"}  ${t.members.map((x) => displayName("species", x.species)).join("・")}  [${arch}]`,
      );
    }
  }
  return 0;
}
