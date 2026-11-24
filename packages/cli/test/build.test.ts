import { describe, expect, it } from "vitest";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { simContext } from "@ca/sim";
import type { PokemonSet } from "@ca/schema";
import { trickRoomSet } from "../src/build.js";

const ctx = simContext(loadPack(new FsPackSource(), "M-C"), gameSpec());
const base = (over: Partial<PokemonSet>): PokemonSet =>
  ({
    species: "kingambit",
    ability: "defiant",
    nature: "Adamant",
    sp: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
    moves: ["kowtowcleave", "suckerpunch", "ironhead", "protect"],
    assumed: [],
    confidence: {},
    ...over,
  }) as PokemonSet;

describe("Trick Room spreads", () => {
  it("moves Speed points to HP / the main stat and picks a −Spe nature for that stat", () => {
    const s = trickRoomSet(ctx, base({}));
    expect(s.nature).toBe("Brave");
    expect(s.sp.spe).toBe(0);
    expect(s.sp.hp).toBe(32);
    const total = (x: PokemonSet) => Object.values(x.sp).reduce((a, v) => a + (v ?? 0), 0);
    expect(total(s)).toBe(total(base({})));
    for (const v of Object.values(s.sp)) expect(v).toBeLessThanOrEqual(32);
  });
  it("special attackers get Quiet, support sets a defensive −Spe nature", () => {
    expect(
      trickRoomSet(
        ctx,
        base({ species: "hatterene", moves: ["dazzlinggleam", "psychic", "trickroom", "protect"] }),
      ).nature,
    ).toBe("Quiet");
    expect(
      trickRoomSet(
        ctx,
        base({
          species: "farigiraf",
          moves: ["trickroom", "protect", "helpinghand", "allyswitch"],
        }),
      ).nature,
    ).toBe("Relaxed");
  });
});
