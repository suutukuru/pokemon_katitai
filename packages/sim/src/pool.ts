// Node-only: run battle jobs across worker threads (`@ca/sim/pool`).
import { Worker } from "node:worker_threads";
import type { PokemonSet } from "@ca/schema";
import type { BattleJob, BestPlayJob, Executor } from "./analyze.js";
import type { BattleResult } from "./runner.js";
import type { ReplayData } from "./replay.js";
import type { RolloutBatch, RolloutExecutor, SearchBudget } from "./search.js";

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
  const send = <T>(w: Worker, msg: object) =>
    new Promise<T>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve as (r: BattleResult[]) => void);
      w.postMessage({ id, ...msg });
    });
  return {
    async bestPlay(jobs: BestPlayJob[]) {
      // long jobs: hand them out one at a time to whichever worker is free
      const out = new Array<BattleResult>(jobs.length);
      let next = 0;
      await Promise.all(
        pool.map(async (w) => {
          while (next < jobs.length) {
            const i = next++;
            out[i] = (await send<BattleResult[]>(w, { bestJobs: [jobs[i]!] }))[0]!;
          }
        }),
      );
      return out;
    },
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

export interface BestPlayTask {
  mine: PokemonSet[];
  theirs: PokemonSet[];
  ca: [number, number, number, number];
  cb: [number, number, number, number];
  seed: number;
  budget: SearchBudget;
}

/** Run best-play battles in parallel (one battle per worker at a time); results keep task order. */
export async function runBestPlayPool(
  regulationId: string,
  tasks: BestPlayTask[],
  workers: number,
  onDone?: (i: number) => void,
): Promise<ReplayData[]> {
  const pool = Array.from(
    { length: Math.max(1, Math.min(workers, tasks.length)) },
    () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        workerData: { regulationId, mine: [], theirs: [] },
        execArgv: ["--import", "tsx"],
      }),
  );
  const results: ReplayData[] = new Array<ReplayData>(tasks.length);
  let next = 0;
  try {
    await Promise.all(
      pool.map(async (w) => {
        while (next < tasks.length) {
          const i = next++;
          results[i] = await new Promise<ReplayData>((resolve, reject) => {
            const onMsg = (msg: { id: number; results: ReplayData }) => {
              if (msg.id !== i) return;
              w.off("message", onMsg);
              resolve(msg.results);
            };
            w.on("message", onMsg);
            w.once("error", reject);
            w.postMessage({ id: i, best: tasks[i] });
          });
          onDone?.(i);
        }
      }),
    );
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
  return results;
}

/**
 * Rollouts split across worker threads: each batch is cut into contiguous chunks (one per worker)
 * and the results are concatenated in item order, so the outcome equals the in-process executor's.
 */
export function workerRollouts(
  regulationId: string,
  workers: number,
): RolloutExecutor & { close(): Promise<void> } {
  const pool = Array.from(
    { length: Math.max(1, workers) },
    () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        workerData: { regulationId, mine: [], theirs: [] },
        execArgv: ["--import", "tsx"],
      }),
  );
  let nextId = 0;
  const pending = new Map<number, (r: number[]) => void>();
  for (const w of pool)
    w.on("message", (msg: { id: number; results: number[] }) => {
      pending.get(msg.id)?.(msg.results);
      pending.delete(msg.id);
    });
  return {
    async rollouts(batch: RolloutBatch) {
      const size = Math.ceil(batch.items.length / pool.length);
      const parts = await Promise.all(
        pool.map((w, i) => {
          const items = batch.items.slice(i * size, (i + 1) * size);
          if (items.length === 0) return Promise.resolve([] as number[]);
          const id = nextId++;
          return new Promise<number[]>((resolve) => {
            pending.set(id, resolve);
            w.postMessage({ id, batch: { state: batch.state, items } });
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
