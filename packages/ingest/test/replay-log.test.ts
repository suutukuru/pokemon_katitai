import { describe, expect, it } from "vitest";
import { parseShowdownReplayLog } from "../src/index.js";

const LOG = `|player|p1|Alice|1
|player|p2|Bob|2
|poke|p1|Incineroar, L50, M|
|switch|p1a: Cat|Incineroar, L50, M|100/100
|switch|p1b: Charizard|Charizard, L50, M|100/100
|switch|p2a: Pelipper|Pelipper, L50, M|100/100
|switch|p2b: Rilla|Rillaboom, L50, F|100/100
|turn|1
|switch|p2b: Arch|Archaludon, L50, F|100/100
|detailschange|p1b: Charizard|Charizard-Mega-Y, L50, M
|-mega|p1b: Charizard|Charizard|Charizardite Y
|move|p1a: Cat|Fake Out|p2a: Pelipper
|-damage|p2a: Pelipper|80/100
|cant|p2a: Pelipper|flinch
|move|p1b: Charizard|Heat Wave|p2a: Pelipper|[spread] p2a,p2b
|-damage|p2a: Pelipper|0 fnt
|-damage|p2b: Arch|62/100
|faint|p2a: Pelipper
|move|p2b: Arch|Flash Cannon|p1b: Charizard
|-damage|p1b: Charizard|55/100 brn
|upkeep
|switch|p2a: Bascu|Basculegion, L50, M|100/100
|turn|2
|move|p1a: Cat|U-turn|p2b: Arch
|-damage|p2b: Arch|50/100
|switch|p1a: Whimsicott|Whimsicott, L50, F|100/100
|move|p1b: Charizard|Solar Beam|p2a: Bascu
|move|p2a: Bascu|Wave Crash|p1b: Charizard
|move|p2b: Arch|Metronome|
|move|p2b: Arch|Draco Meteor|p1b: Charizard|[from]move: Metronome
|-boost|p2b: Arch|spa|1
|upkeep
|turn|3
|win|Alice
`;

describe("Showdown replay log → record turns", () => {
  const r = parseShowdownReplayLog(LOG);
  it("brought, winner, state at turn start", () => {
    expect(r.issues).toEqual([]);
    expect(r.winner).toBe(0);
    expect(r.brought).toEqual([
      ["incineroar", "charizard", "whimsicott"],
      ["pelipper", "rillaboom", "archaludon", "basculegion"],
    ]);
    expect(r.turns[1]!.state).toEqual([
      [
        { species: "incineroar", hpPct: 100 },
        { species: "charizard", hpPct: 55, status: "brn" },
      ],
      [
        { species: "basculegion", hpPct: 100 },
        { species: "archaludon", hpPct: 62 },
      ],
    ]);
  });
  it("actions: voluntary switch, mega, flinch, spread; replacements after upkeep", () => {
    expect(r.turns[0]!.actions).toEqual([
      [
        { move: "fakeout", target: "pelipper" },
        { move: "heatwave", mega: true },
      ],
      [{ unknown: true }, { switch: "archaludon" }],
    ]);
    expect(r.turns[0]!.replacements).toEqual([[], ["basculegion"]]);
  });
  it("a U-turn switch is not a choice; a move called by Metronome is not either", () => {
    expect(r.turns[1]!.actions).toEqual([
      [
        { move: "uturn", target: "archaludon" },
        { move: "solarbeam", target: "basculegion" },
      ],
      [{ move: "wavecrash", target: "charizard" }, { move: "metronome" }],
    ]);
    expect(r.turns[2]!.state![1][1]).toEqual({
      species: "archaludon",
      hpPct: 50,
      boosts: { spa: 1 },
    });
    expect(r.turns[2]!.state![0][0]!.species).toBe("whimsicott");
  });
});
