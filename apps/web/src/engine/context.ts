// Simulation context in the browser (main thread and workers): bundled packs, no network.
import { gameSpec, loadPack } from "@ca/data";
import { MECHANIC_IDS } from "@ca/engine";
import { simContext, type SimContext } from "@ca/sim";
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
