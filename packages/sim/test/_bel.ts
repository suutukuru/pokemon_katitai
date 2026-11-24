import { readFileSync } from "node:fs";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource, readUsageSnapshots } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import { simContext, startBattle, playOut } from "../src/runner.js";
import { snap, restore, reseed } from "../src/replay.js";
import { observe, determinize, priorFromUsage } from "../src/belief.js";
import { step } from "../src/view.js";
import { Rng } from "../src/rng.js";
const pack = loadPack(new FsPackSource(), "M-C");
const ctx = simContext(pack, gameSpec());
const prior = priorFromUsage(readUsageSnapshots("M-C")[0]!);
const a = parseShowdown(readFileSync("my-teams/team2.txt", "utf8")).members;
const b = parseShowdown(readFileSync("my-teams/team1.txt", "utf8")).members;
let s = snap(startBattle(ctx, a, b, [0, 1, 2, 3], [0, 1, 2, 3], 5));
for (let i = 0; i < 2; i++) s = step(ctx, s, "", "").state;
const real = restore(s);
const obs = observe(real, 0);
console.log(JSON.stringify(obs));
const rng = new Rng(3);
for (let k = 0; k < 3; k++) {
  const w = determinize(ctx, s, real, obs, prior, rng);
  const wb = restore(w);
  console.log(
    wb.sides[1].pokemon
      .map(
        (p) =>
          `${p.species.id} ${p.hp}/${p.maxhp} ${p.item} ${p.ability} [${(p as any).moveSlots.map((m: any) => m.id + (m.used ? "*" : "")).join(",")}] spe${(p as any).storedStats.spe}`,
      )
      .join(" | "),
  );
  reseed(wb, k);
  console.log(" playout", JSON.stringify(playOut(ctx, wb, k)));
}
console.log(
  "REAL",
  real.sides[1].pokemon
    .map(
      (p) =>
        `${p.species.id} ${p.hp}/${p.maxhp} ${p.item} ${p.ability} spe${(p as any).storedStats.spe}`,
    )
    .join(" | "),
);
