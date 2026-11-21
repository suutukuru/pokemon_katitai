import { readFileSync } from "node:fs";
import { PokemonSetSchema, type PokemonSet, type ResolvedPack } from "@ca/schema";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { parseShowdown } from "@ca/ingest";
import { MECHANIC_IDS } from "../src/index.js";

export const spec = gameSpec();
export const pack: ResolvedPack = loadPack(new FsPackSource(), "M-C", {
  knownMechanics: MECHANIC_IDS,
});
export const NOW = new Date("2026-11-21T00:00:00Z");

export function sampleTeam(id: string): PokemonSet[] {
  const text = readFileSync(new URL(`../../data/teams/samples/${id}.txt`, import.meta.url), "utf8");
  const r = parseShowdown(text, {
    legal: { species: pack.legal.species, items: pack.legal.items },
  });
  if (r.issues.some((i) => i.severity === "error")) throw new Error(JSON.stringify(r.issues));
  return r.members;
}

export function mon(
  partial: Partial<PokemonSet> & { species: string; ability: string; moves: string[] },
): PokemonSet {
  return PokemonSetSchema.parse({
    nature: "Hardy",
    sp: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ...partial,
  });
}

/** Pack with modified weights (for parameter tests). */
export function withWeights(patch: (w: ResolvedPack["weights"]) => void): ResolvedPack {
  const p = structuredClone(pack);
  patch(p.weights);
  return p;
}
