import { describe, expect, it } from "vitest";
import type { TeamRecord } from "@ca/schema";
import {
  baseDex,
  dexWithNewSpecies,
  estimateTeam,
  importSmogonChaos,
  loadPack,
  mostCommonSet,
  queryTeams,
} from "../src/index.js";
import { FsPackSource, readTeamDbFiles, readUsageSnapshots } from "../src/node.js";

const pack = loadPack(new FsPackSource(), "M-C");
const dex = dexWithNewSpecies(baseDex(), pack.overrides.newSpecies);
const chaos = {
  info: { metagame: "gen9championsvgc2026regmc", cutoff: 1760, "number of battles": 1000 },
  data: {
    "Charizard-Mega-Y": {
      usage: 0.3,
      Abilities: { drought: 100 },
      Items: { charizarditey: 100 },
      Moves: { heatwave: 100, weatherball: 90, protect: 70, solarbeam: 40, "": 10 },
      Spreads: { "Quiet:32/0/2/32/0/0": 60, "Bogus:1/2": 5 },
      Teammates: { Kingambit: 50 },
    },
    "Floette-Mega": {
      usage: 0.1,
      Abilities: { fairyaura: 10 },
      Items: { floettite: 10 },
      Moves: { moonblast: 10 },
      Spreads: { "Modest:2/0/0/32/0/32": 10 },
      Teammates: {},
    },
    Garchomp: {
      usage: 0.2,
      Abilities: { roughskin: 50 },
      Items: { choicescarf: 30, lifeorb: 20 },
      Moves: { protect: 45, earthquake: 50, rockslide: 48, dragonclaw: 47, stompingtantrum: 40 },
      Spreads: { "Jolly:2/32/0/0/0/32": 50 },
      Teammates: {},
    },
    "Flutter Mane": {
      usage: 0.5,
      Abilities: { protosynthesis: 1 },
      Items: {},
      Moves: { moonblast: 1 },
      Spreads: { "Timid:0/0/0/32/0/32": 1 },
      Teammates: {},
    },
    Rare: { usage: 0.001, Abilities: {}, Items: {}, Moves: {}, Spreads: {}, Teammates: {} },
  },
};

describe("Smogon chaos import", () => {
  const r = importSmogonChaos(chaos, {
    regulationId: "M-C",
    month: "2026-10",
    url: "https://example.invalid",
    legalSpecies: pack.legal.species,
    dex,
    minUsage: 0.005,
    topK: 12,
  });
  it("maps Megas to the base species with the base ability, drops illegal and rare species", () => {
    const zard = r.snapshot.entries.find((e) => e.species === "charizard")!;
    expect(zard.sets[0]).toMatchObject({
      mega: true,
      item: "charizarditey",
      ability: "blaze",
      nature: "Quiet",
      moves: ["heatwave", "weatherball", "protect", "solarbeam"],
    });
    expect(r.snapshot.entries.find((e) => e.species === "floetteeternal")?.sets[0]?.mega).toBe(
      true,
    );
    expect(r.skipped).toEqual(["Flutter Mane"]);
    expect(r.snapshot).toMatchObject({
      date: "2026-10-31",
      battles: 1000,
      cutoff: 1760,
      sample: false,
    });
    expect(zard.distributions!.spreads).toEqual([
      { nature: "Quiet", sp: { hp: 32, atk: 0, def: 2, spa: 32, spd: 0, spe: 0 }, share: 0.6 },
    ]);
  });
  it("drops status moves when the item is a Choice item", () => {
    const g = r.snapshot.entries.find((e) => e.species === "garchomp")!;
    expect(g.sets[0]!.moves).not.toContain("protect");
    expect(mostCommonSet(g.distributions!, "lifeorb")!.moves).toContain("protect");
  });
});

describe("estimateTeam (open data + usage)", () => {
  const usage = readUsageSnapshots("M-C")[0]!;
  it("the committed snapshot is the newest, highest-cutoff M-C file", () => {
    expect(usage).toMatchObject({ regulationId: "M-C", date: "2026-10-31", cutoff: 1760 });
    expect(usage.entries[0]!.species).toBe("sneasler");
  });
  it("completes top M-C teams, keeping open-data items and marking estimates", () => {
    const t = queryTeams(readTeamDbFiles(), { seasons: [6, 99] }).find(
      (x) => x.season === "M-7" && x.rank === 4,
    )!;
    const e = estimateTeam(t, usage, dex);
    expect(e.missing).toEqual([]);
    expect(e.sets).toHaveLength(6);
    const pel = e.sets.find((s) => s.species === "pelipper")!;
    expect(pel.item).toBe("choicescarf");
    expect(pel.assumed).toEqual(["moves", "ability", "nature", "sp"]);
    expect(pel.moves.some((m) => m === "tailwind" || m === "wideguard")).toBe(false); // no status moves with Scarf
    expect(e.sets.find((s) => s.species === "charizard")).toMatchObject({
      item: "charizarditey",
      ability: "blaze",
    });
  });
  it("reports species without usage data", () => {
    const fake: TeamRecord = {
      ...queryTeams(readTeamDbFiles())[0]!,
      members: [{ species: "audino" }, { species: "sneasler", item: "whiteherb" }],
    };
    const e = estimateTeam(fake, usage, dex);
    expect(e.missing).toEqual(["audino"]);
    expect(e.sets[0]).toMatchObject({ species: "sneasler", item: "whiteherb" });
  });
});
