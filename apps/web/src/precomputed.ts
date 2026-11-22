// Results of `pnpm web:data` (heavy CLI simulations), loaded lazily per matchup.
import index from "./data/precomputed/index.json";
import type { MatchupAnalysis, PositionAnalysis, ReplayData, SearchBudget, Config } from "@ca/sim";

export interface PrecomputedMatchup {
  regulationId: string;
  dataVersion: string;
  team: { name: string; hash: string };
  opponent: { id: string; label: string; hash: string };
  seed: number;
  scale: number;
  analysis: MatchupAnalysis;
  bring: { mine: Config; theirs: Config };
  best: ReplayData;
  search: SearchBudget;
  positions: Record<string, PositionAnalysis>;
}

interface IndexEntry {
  file: string;
  team: string;
  teamHash: string;
  opponent: string;
  opponentHash: string;
  label: string;
  value: number;
  winner: 0 | 1 | null;
}

const files = import.meta.glob(["./data/precomputed/*.json", "!./data/precomputed/index.json"], {
  import: "default",
});
export const precomputedIndex = (index as { entries: IndexEntry[] }).entries;

export function findPrecomputed(teamHash: string, oppHash: string): IndexEntry | undefined {
  return precomputedIndex.find((e) => e.teamHash === teamHash && e.opponentHash === oppHash);
}

export async function loadPrecomputed(file: string): Promise<PrecomputedMatchup | undefined> {
  const f = files[`./data/precomputed/${file}`];
  return f ? ((await f()) as PrecomputedMatchup) : undefined;
}
