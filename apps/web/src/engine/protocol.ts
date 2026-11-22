import type { PokemonSet } from "@ca/schema";
import type { BattleJob, BattleResult, BestPlayJob, RolloutBatch } from "@ca/sim";

/** Messages to a simulation worker. Every request carries an id; the reply echoes it. */
export type SimRequest =
  | { id: number; kind: "rollouts"; regulationId: string; batch: RolloutBatch }
  | {
      id: number;
      kind: "battles";
      regulationId: string;
      mine: PokemonSet[];
      theirs: PokemonSet[];
      jobs: BattleJob[];
    }
  | {
      id: number;
      kind: "bestPlay";
      regulationId: string;
      mine: PokemonSet[];
      theirs: PokemonSet[];
      jobs: BestPlayJob[];
    };

export type SimReply =
  | { id: number; ok: true; results: number[] | BattleResult[] }
  | { id: number; ok: false; message: string };
