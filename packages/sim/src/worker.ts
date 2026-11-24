import { parentPort, workerData } from "node:worker_threads";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource, readUsageSnapshots } from "@ca/data/node";
import { priorFromUsage } from "./belief.js";
import type { PokemonSet } from "@ca/schema";
import { inProcessExecutor, type BattleJob, type BestPlayJob } from "./analyze.js";
import { playBestBattle } from "./bestplay.js";
import type { PoolInit } from "./pool.js";
import { duel, simContext, type Config } from "./runner.js";
import type { DuelJob } from "./tune.js";
import {
  rollout,
  rolloutContext,
  worldOf,
  type RolloutBatch,
  type SearchBudget,
} from "./search.js";

const init = workerData as PoolInit;
const ctx = simContext(loadPack(new FsPackSource(), init.regulationId), gameSpec());
const rctx = rolloutContext(ctx);
// hidden-information planning needs the usage prior (latest snapshot of this regulation)
const usage = readUsageSnapshots(init.regulationId)[0];
const prior = usage ? priorFromUsage(usage) : undefined;
const exec = inProcessExecutor(ctx, init.mine, init.theirs, prior);
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
    duels?: DuelJob[];
  }) => {
    if (msg.duels) {
      parentPort!.postMessage({
        id: msg.id,
        results: msg.duels.map((d) => duel(ctx, d.a, d.b, d.ca, d.cb, d.seed, d.params)),
      });
      return;
    }
    if (msg.bestJobs) {
      parentPort!.postMessage({ id: msg.id, results: await exec.bestPlay!(msg.bestJobs) });
      return;
    }
    if (msg.batch) {
      const batch = msg.batch;
      parentPort!.postMessage({
        id: msg.id,
        results: batch.items.map((it) => rollout(rctx, worldOf(batch, it), it)),
      });
      return;
    }
    if (msg.best) {
      const t = msg.best;
      parentPort!.postMessage({
        id: msg.id,
        results: await playBestBattle(
          ctx,
          t.mine,
          t.theirs,
          t.ca,
          t.cb,
          t.seed,
          t.budget,
          undefined,
          prior ? { prior } : {},
        ),
      });
      return;
    }
    parentPort!.postMessage({ id: msg.id, results: await exec.run(msg.jobs ?? []) });
  },
);
