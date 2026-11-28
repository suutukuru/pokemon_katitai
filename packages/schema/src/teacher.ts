import { z } from "zod";
import { PokemonSetSchema } from "./team.js";

/**
 * Positions labelled by the rollout search ("teacher"), for measuring how close the heuristic
 * policy is to searched play when no real battle records are available (ADR-0011).
 * A position is reproduced exactly by replaying `history` (every `choose` call) from `seed`.
 */
export const TeacherCandidateSchema = z.object({
  choice: z.string(),
  winRate: z.number().min(0).max(1),
  games: z.number().int().min(1),
  /** successive-halving stage reached */
  stage: z.number().int().min(1),
});
export type TeacherCandidate = z.infer<typeof TeacherCandidateSchema>;

const ConfigSchema = z.tuple([
  z.number().int(),
  z.number().int(),
  z.number().int(),
  z.number().int(),
]);

export const TeacherPositionSchema = z.object({
  id: z.string(),
  /** keys into `teams` for side 0 / side 1 */
  teams: z.tuple([z.string(), z.string()]),
  configs: z.tuple([ConfigSchema, ConfigSchema]),
  seed: z.number().int(),
  history: z.array(z.tuple([z.union([z.literal(0), z.literal(1)]), z.string()])),
  side: z.union([z.literal(0), z.literal(1)]),
  turn: z.number().int().min(1),
  /** the teacher's pick (highest win rate among the finalists) */
  best: z.string(),
  candidates: z.array(TeacherCandidateSchema).min(1),
});
export type TeacherPosition = z.infer<typeof TeacherPositionSchema>;

export const TeacherDatasetSchema = z.object({
  regulationId: z.string(),
  /** what produced the labels (commit, search budget) — informational */
  generator: z.record(z.string(), z.union([z.string(), z.number()])),
  teams: z.record(z.string(), z.array(PokemonSetSchema).min(4).max(6)),
  positions: z.array(TeacherPositionSchema),
});
export type TeacherDataset = z.infer<typeof TeacherDatasetSchema>;
