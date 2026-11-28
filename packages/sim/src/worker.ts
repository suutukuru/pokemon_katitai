import { parentPort, workerData } from "node:worker_threads";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { inProcessExecutor, type BattleJob } from "./analyze.js";
import type { PoolInit } from "./pool.js";
import { simContext, type Config } from "./runner.js";
import { playBestBattle, type SearchOptions } from "./bestplay.js";
import type { PokemonSet } from "@ca/schema";
import { teacherBattle } from "./teacher.js";

const init = workerData as PoolInit;
const ctx = simContext(loadPack(new FsPackSource(), init.regulationId), gameSpec());
const exec = inProcessExecutor(ctx, init.mine, init.theirs);
interface BestTask {
  mine: PokemonSet[];
  theirs: PokemonSet[];
  ca: Config;
  cb: Config;
  seed: number;
  opts: SearchOptions;
}
interface TeacherTask {
  teams: [string, string];
  a: PokemonSet[];
  b: PokemonSet[];
  configs: [Config, Config];
  seed: number;
  opts: SearchOptions;
  kinds?: ("move" | "switch")[];
}
parentPort!.on(
  "message",
  async (msg: { id: number; jobs?: BattleJob[]; best?: BestTask; teacher?: TeacherTask }) => {
    if (msg.teacher) {
      const t = msg.teacher;
      parentPort!.postMessage({
        id: msg.id,
        results: teacherBattle(ctx, t.teams, t.a, t.b, t.configs, t.seed, t.opts, t.kinds),
      });
      return;
    }
    if (msg.best) {
      const t = msg.best;
      parentPort!.postMessage({
        id: msg.id,
        results: playBestBattle(ctx, t.mine, t.theirs, t.ca, t.cb, t.seed, t.opts),
      });
      return;
    }
    parentPort!.postMessage({ id: msg.id, results: await exec.run(msg.jobs ?? []) });
  },
);
