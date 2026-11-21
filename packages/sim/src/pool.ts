// Node-only: run battle jobs across worker threads (`@ca/sim/pool`).
import { Worker } from "node:worker_threads";
import type { PokemonSet } from "@ca/schema";
import type { BattleJob, Executor } from "./analyze.js";
import type { BattleResult } from "./runner.js";

export interface PoolInit {
  regulationId: string;
  mine: PokemonSet[];
  theirs: PokemonSet[];
}

/** Splits jobs into contiguous chunks per worker; results keep job order (deterministic). */
export function workerPoolExecutor(
  init: PoolInit,
  workers: number,
): Executor & { close(): Promise<void> } {
  const pool = Array.from(
    { length: workers },
    () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        workerData: init,
        execArgv: ["--import", "tsx"],
      }),
  );
  let nextId = 0;
  const pending = new Map<number, (r: BattleResult[]) => void>();
  for (const w of pool) {
    w.on("message", (msg: { id: number; results: BattleResult[] }) => {
      pending.get(msg.id)?.(msg.results);
      pending.delete(msg.id);
    });
  }
  return {
    async run(jobs: BattleJob[]) {
      const size = Math.ceil(jobs.length / pool.length);
      const parts = await Promise.all(
        pool.map((w, i) => {
          const chunk = jobs.slice(i * size, (i + 1) * size);
          if (chunk.length === 0) return Promise.resolve([] as BattleResult[]);
          const id = nextId++;
          return new Promise<BattleResult[]>((resolve) => {
            pending.set(id, resolve);
            w.postMessage({ id, jobs: chunk });
          });
        }),
      );
      return parts.flat();
    },
    async close() {
      await Promise.all(pool.map((w) => w.terminate()));
    },
  };
}
