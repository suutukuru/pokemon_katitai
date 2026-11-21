import { PackIdSchema } from "@ca/schema";
import type { PackFile } from "./source.js";

export interface ScaffoldOptions {
  id: string;
  extends?: string;
  nameJa?: string;
  nameEn?: string;
  /** ISO date used for dataVersion. */
  today: string;
}

/** Files for a new pack. Child packs contain only empty deltas; root packs need full rules/weights. */
export function scaffoldPack(o: ScaffoldOptions): Record<PackFile, unknown> {
  PackIdSchema.parse(o.id);
  if (o.extends !== undefined) PackIdSchema.parse(o.extends);
  const emptyDelta = { add: [], remove: [] };
  const manifest = {
    id: o.id,
    name: { ja: o.nameJa ?? `レギュレーション ${o.id}`, en: o.nameEn ?? `Regulation ${o.id}` },
    ...(o.extends !== undefined ? { extends: o.extends } : {}),
    periods: {},
    mechanics: emptyDelta,
    dataVersion: `${o.today}.1`,
    verified: false,
    sources: [],
    notes: "TODO: 出典を確認したら sources に追加し verified を true にする",
  };
  const legal = {
    verified: false,
    species: emptyDelta,
    megaSpecies: emptyDelta,
    items: emptyDelta,
    bannedMoves: emptyDelta,
    bannedAbilities: emptyDelta,
  };
  const overrides = { species: {}, newSpecies: {}, moves: {}, abilities: {}, items: {} };
  const rules =
    o.extends !== undefined
      ? {}
      : {
          format: "doubles",
          level: 50,
          teamSize: 6,
          bringCount: 4,
          activeCount: 2,
          speciesClause: true,
          itemClause: true,
          megaPerBattle: 1,
          verified: false,
        };
  const weights =
    o.extends !== undefined
      ? {}
      : { version: `${o.today}.manual`, origin: "manual", rules: {}, evaluation: {}, search: {} };
  return { manifest, legal, overrides, rules, weights };
}
