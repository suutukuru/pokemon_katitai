// Simulation context in the browser (main thread and workers): bundled packs, no network.
import { gameSpec, loadPack, parseUsageSnapshot } from "@ca/data";
import { MECHANIC_IDS } from "@ca/engine";
import { priorFromUsage, simContext, type Prior, type SimContext } from "@ca/sim";
import { packSource } from "../bundled";

const cache = new Map<string, SimContext>();
export function contextFor(regulationId: string): SimContext {
  let c = cache.get(regulationId);
  if (!c) {
    c = simContext(
      loadPack(packSource, regulationId, { knownMechanics: MECHANIC_IDS }),
      gameSpec(),
    );
    cache.set(regulationId, c);
  }
  return c;
}

// Usage statistics: the prior over the opponent's hidden sets (newest, highest-cutoff snapshot).
const usageFiles = import.meta.glob("../../../../packages/data/usage/*/*.json", {
  import: "default",
});
const priors = new Map<string, Promise<Prior | undefined>>();
export function priorFor(regulationId: string): Promise<Prior | undefined> {
  let p = priors.get(regulationId);
  if (!p) {
    const key = Object.keys(usageFiles)
      .filter((k) => k.includes(`/usage/${regulationId}/`))
      .sort((a, b) => {
        const m = (k: string) => /(\d{4}-\d{2})-\w+-(\d+)\.json$/.exec(k) ?? ["", "", "0"];
        return m(b)[1]!.localeCompare(m(a)[1]!) || Number(m(b)[2]) - Number(m(a)[2]);
      })[0];
    p = key
      ? usageFiles[key]!().then((j) => priorFromUsage(parseUsageSnapshot(j)))
      : Promise.resolve(undefined);
    priors.set(regulationId, p);
  }
  return p;
}
