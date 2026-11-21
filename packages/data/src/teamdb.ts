import { TeamDatabaseFileSchema, type TeamDatabaseFile, type TeamRecord } from "@ca/schema";

export function parseTeamDbFile(json: unknown): TeamDatabaseFile {
  return TeamDatabaseFileSchema.parse(json);
}

/** "M-7" → 7 (season order). */
export const seasonNumber = (season: string) => Number(/(\d+)$/.exec(season)?.[1] ?? NaN);

export interface TeamQuery {
  format?: "doubles" | "singles";
  /** Inclusive season-number range. */
  seasons?: [number, number];
  /** Only teams whose members are all legal under this species list. */
  legalSpecies?: readonly string[];
}

export function queryTeams(files: readonly TeamDatabaseFile[], q: TeamQuery = {}): TeamRecord[] {
  const legal = q.legalSpecies ? new Set(q.legalSpecies) : undefined;
  return files
    .filter((f) => !q.format || f.format === q.format)
    .filter(
      (f) =>
        !q.seasons ||
        (seasonNumber(f.season) >= q.seasons[0] && seasonNumber(f.season) <= q.seasons[1]),
    )
    .flatMap((f) => f.teams)
    .filter((t) => !legal || t.members.every((m) => legal.has(m.species)))
    .sort(
      (a, b) =>
        seasonNumber(b.season) - seasonNumber(a.season) || (a.rank ?? 1e9) - (b.rank ?? 1e9),
    );
}
