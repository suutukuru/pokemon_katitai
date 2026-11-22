// A pool of simulation workers. Work is split into contiguous chunks in a fixed order, so results
// are identical to running everything in one thread (and to the CLI with the same seed/budget).
import type { PokemonSet } from "@ca/schema";
import type {
  BattleJob,
  BattleResult,
  BestPlayJob,
  Executor,
  RolloutBatch,
  RolloutExecutor,
} from "@ca/sim";
import type { SimReply, SimRequest } from "./protocol";

type Pending = { resolve: (r: unknown) => void; reject: (e: Error) => void };
type Body =
  | { kind: "rollouts"; batch: RolloutBatch }
  | { kind: "battles"; mine: PokemonSet[]; theirs: PokemonSet[]; jobs: BattleJob[] }
  | { kind: "bestPlay"; mine: PokemonSet[]; theirs: PokemonSet[]; jobs: BestPlayJob[] };

export function defaultWorkers(): number {
  const n = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
  // leave one core for the page; at least 2, at most 8
  return Math.max(2, Math.min(8, n - 1));
}

export class SimPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  /** rollouts/battles finished since the last reset (for progress bars) */
  done = 0;
  onWork?: (done: number) => void;

  constructor(
    private regulationId: string,
    readonly size = defaultWorkers(),
  ) {
    this.spawn();
  }

  private spawn() {
    this.workers = Array.from({ length: this.size }, () => {
      const w = new Worker(new URL("./simWorker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<SimReply>) => {
        const p = this.pending.get(ev.data.id);
        if (!p) return;
        this.pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.results);
        else p.reject(new Error(ev.data.message));
      };
      w.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.message || "worker error"));
        this.pending.clear();
      };
      return w;
    });
  }

  /** Stop everything in flight (pending promises reject) and start fresh workers. */
  cancel() {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error("cancelled"));
    this.pending.clear();
    this.spawn();
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }

  private send<T>(w: Worker, body: Body): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      w.postMessage({ id, regulationId: this.regulationId, ...body } as SimRequest);
    });
  }

  private async split<J, R>(
    jobs: J[],
    make: (chunk: J[]) => Body,
    chunkSize?: number,
  ): Promise<R[]> {
    if (jobs.length === 0) return [];
    // chunks small enough for progress updates, big enough to amortize messaging
    const size = chunkSize ?? Math.max(1, Math.min(64, Math.ceil(jobs.length / (this.size * 4))));
    const chunks: J[][] = [];
    for (let i = 0; i < jobs.length; i += size) chunks.push(jobs.slice(i, i + size));
    const out: R[][] = new Array(chunks.length);
    let next = 0;
    await Promise.all(
      this.workers.map(async (w) => {
        while (next < chunks.length) {
          const i = next++;
          out[i] = await this.send<R[]>(w, make(chunks[i]!));
          this.done += chunks[i]!.length;
          this.onWork?.(this.done);
        }
      }),
    );
    return out.flat();
  }

  rolloutExecutor(): RolloutExecutor {
    return {
      rollouts: (batch) =>
        this.split<RolloutBatch["items"][number], number>(batch.items, (items) => ({
          kind: "rollouts",
          batch: { state: batch.state, items },
        })),
    };
  }

  executor(mine: PokemonSet[], theirs: PokemonSet[]): Executor {
    return {
      run: (jobs) =>
        this.split<BattleJob, BattleResult>(jobs, (c) => ({
          kind: "battles",
          mine,
          theirs,
          jobs: c,
        })),
      bestPlay: (jobs) =>
        this.split<BestPlayJob, BattleResult>(
          jobs,
          (c) => ({ kind: "bestPlay", mine, theirs, jobs: c }),
          1,
        ),
    };
  }
}
