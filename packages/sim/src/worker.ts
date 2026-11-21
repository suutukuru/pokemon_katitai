import { parentPort, workerData } from "node:worker_threads";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { inProcessExecutor, type BattleJob } from "./analyze.js";
import type { PoolInit } from "./pool.js";
import { simContext } from "./runner.js";

const init = workerData as PoolInit;
const ctx = simContext(loadPack(new FsPackSource(), init.regulationId), gameSpec());
const exec = inProcessExecutor(ctx, init.mine, init.theirs);
parentPort!.on("message", async (msg: { id: number; jobs: BattleJob[] }) => {
  parentPort!.postMessage({ id: msg.id, results: await exec.run(msg.jobs) });
});
