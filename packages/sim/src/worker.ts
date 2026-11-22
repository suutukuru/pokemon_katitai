import { parentPort, workerData } from "node:worker_threads";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import type { PokemonSet } from "@ca/schema";
import { inProcessExecutor, type BattleJob, type BestPlayJob } from "./analyze.js";
import { playBestBattle } from "./bestplay.js";
import type { PoolInit } from "./pool.js";
import { simContext, type Config } from "./runner.js";
import { rollout, rolloutContext, type RolloutBatch, type SearchBudget } from "./search.js";

const init = workerData as PoolInit;
const ctx = simContext(loadPack(new FsPackSource(), init.regulationId), gameSpec());
const rctx = rolloutContext(ctx);
const exec = inProcessExecutor(ctx, init.mine, init.theirs);
interface BestTask {
  mine: PokemonSet[];
  theirs: PokemonSet[];
  ca: Config;
  cb: Config;
  seed: number;
  budget: SearchBudget;
}
parentPort!.on(
  "message",
  async (msg: {
    id: number;
    jobs?: BattleJob[];
    best?: BestTask;
    batch?: RolloutBatch;
    bestJobs?: BestPlayJob[];
  }) => {
    if (msg.bestJobs) {
      parentPort!.postMessage({ id: msg.id, results: await exec.bestPlay!(msg.bestJobs) });
      return;
    }
    if (msg.batch) {
      const { state, items } = msg.batch;
      parentPort!.postMessage({ id: msg.id, results: items.map((it) => rollout(rctx, state, it)) });
      return;
    }
    if (msg.best) {
      const t = msg.best;
      parentPort!.postMessage({
        id: msg.id,
        results: await playBestBattle(ctx, t.mine, t.theirs, t.ca, t.cb, t.seed, t.budget),
      });
      return;
    }
    parentPort!.postMessage({ id: msg.id, results: await exec.run(msg.jobs ?? []) });
  },
);
