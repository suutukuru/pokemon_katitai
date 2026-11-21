import { PokemonSetSchema, type PokemonSet } from "@ca/schema";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { ChampionsCalc } from "../src/index.js";
import golden from "./golden/ingame-stats.json" with { type: "json" };

export const spec = gameSpec();
export const pack = loadPack(new FsPackSource(), "M-C");
export const calc = new ChampionsCalc(pack, spec);

export const team: Record<string, PokemonSet> = Object.fromEntries(
  golden.members.map((m) => {
    const set = PokemonSetSchema.parse(m.set);
    return [set.species, set];
  }),
);
export const observed: Record<string, Record<string, number>> = Object.fromEntries(
  golden.members.map((m) => [PokemonSetSchema.parse(m.set).species, m.observed]),
);
