import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gameSpec, loadPack } from "@ca/data";
import { FsPackSource } from "@ca/data/node";
import { calcCommand, teamCheck, type Io, type TeamEnv } from "../src/index.js";

const fixture = new URL("../../ingest/test/fixtures/user-team-1.ja.txt", import.meta.url).pathname;
const files: Record<string, string> = {
  "team.txt": readFileSync(fixture, "utf8"),
  "bad.txt":
    "マスカーニヤ\nAbility: Protean\nSPs: 33 Atk / 34 Spe\n- Flower Trick\n\nFlutter Mane\nAbility: Protosynthesis\n- Moonblast",
  "foe.txt": "Incineroar\nAbility: Intimidate\nSPs: 32 HP / 32 SpD\nCareful Nature\n- Fake Out",
};
const env: TeamEnv = {
  pack: loadPack(new FsPackSource(), "M-C"),
  spec: gameSpec(),
  readText: (p) => {
    const t = files[p];
    if (t === undefined) throw new Error(`no file ${p}`);
    return t;
  },
};
function io(): Io & { o: string[]; e: string[] } {
  const o: string[] = [];
  const e: string[] = [];
  return { o, e, out: (l) => o.push(l), err: (l) => e.push(l) };
}

describe("team:check", () => {
  it("prints Champions stats for each member", () => {
    const x = io();
    expect(teamCheck(["team.txt"], env, x)).toBe(0);
    const text = x.o.join("\n");
    expect(text).toContain("エルフーン @ きあいのタスキ / いたずらごころ / おくびょう");
    expect(text).toContain("すばやさ 184(32)");
    expect(text).toContain("10まんばりき");
    expect(x.e).toEqual([]);
  });
  it("reports name corrections, illegal species and SP cap errors", () => {
    const x = io();
    expect(teamCheck(["bad.txt"], env, x)).toBe(1);
    const err = x.e.join("\n");
    expect(err).toContain(
      "[確認] 1行目 species: 「マスカーニヤ」を「マスカーニャ」と読み替えました",
    );
    expect(err).toContain("「Flutter Mane」が見つかりません（候補:");
    expect(err).toContain("SP 33 exceeds the per-stat cap 32");
    expect(teamCheck([], env, io())).toBe(2);
  });
});

describe("calc", () => {
  it("prints damage, KO odds and evidence in Japanese", () => {
    const x = io();
    expect(calcCommand(["team.txt", "プテラ", "いわなだれ", "リザードン"], env, x)).toBe(0);
    expect(x.o[0]).toBe("プテラ の いわなだれ → リザードン");
    expect(x.o[1]).toContain("ダメージ 168〜196");
    expect(x.o[2]).toContain("急所なし 62.5%");
    expect(x.o.join("\n")).toContain("レギュレーション M-C");
  });
  it("supports mega, weather, English names and a separate defender team", () => {
    const x = io();
    expect(
      calcCommand(
        [
          "team.txt",
          "Charizard",
          "Heat Wave",
          "Incineroar",
          "--mega",
          "--weather",
          "Sun",
          "--def-team",
          "foe.txt",
        ],
        env,
        x,
      ),
    ).toBe(0);
    expect(x.o[0]).toBe("メガリザードンY の ねっぷう → ガオガエン（天気: はれ）");
  });
  it("explains missing members and moves", () => {
    const a = io();
    expect(calcCommand(["team.txt", "ピカチュウ", "いわなだれ", "リザードン"], env, a)).toBe(1);
    expect(a.e[0]).toContain("ポケモンが見つかりません");
    const b = io();
    expect(calcCommand(["team.txt", "プテラ", "じしん", "リザードン"], env, b)).toBe(1);
    expect(b.e[0]).toContain("「じしん」を覚えていません");
    expect(calcCommand(["team.txt"], env, io())).toBe(2);
  });
});

describe("meta", () => {
  it("prints usage, pairs, archetypes and teams with the source", async () => {
    const { metaCommand } = await import("../src/index.js");
    const { readTeamDbFiles } = await import("@ca/data/node");
    const x = io();
    expect(
      metaCommand(
        ["--from", "5", "--to", "7", "--top", "3", "--teams"],
        readTeamDbFiles(),
        env.pack.legal.species,
        x,
      ),
    ).toBe(0);
    const out = x.o.join("\n");
    expect(out).toContain(
      "上位構築 45件（M-5, M-6, M-7・ダブル）出典: バトルデータベース チャンピオンズ",
    );
    expect(out).toContain("ブリジュラス＋ペリッパー  9件（20%）");
    expect(out).toMatch(/M-7 +4位 2354\.916 +リザードン・/);
  });
});

describe("sim", () => {
  it("runs a tiny-budget matchup and prints selection, matrix and turn-1 sections", async () => {
    const { simCommand } = await import("../src/index.js");
    const tiny = structuredClone(env.pack);
    Object.assign(tiny.weights.simulation, {
      screenBattles: 1,
      topConfigs: 2,
      matrixBattles: 1,
      turnOptions: 2,
      turnRollouts: 1,
      fictitiousIterations: 200,
    });
    files["rain.txt"] = readFileSync(
      new URL("../../data/teams/samples/sample-rain.txt", import.meta.url),
      "utf8",
    );
    const x = io();
    expect(
      await simCommand(["team.txt", "rain.txt", "--seed", "3"], { ...env, pack: tiny }, x),
    ).toBe(0);
    const out = x.o.join("\n");
    expect(out).toContain("■ 選出と初手");
    expect(out).toContain("■ 選出の読み合い");
    expect(out).toContain("■ 1ターン目の択");
    expect(out).toContain("推測を含む");
    expect(x.e.some((l) => l.includes("screening"))).toBe(true);
    const j = io();
    await simCommand(["team.txt", "rain.txt", "--json"], { ...env, pack: tiny }, j);
    expect(JSON.parse(j.o.join("\n")).turnOne.myOptions).toHaveLength(2);
    expect(await simCommand(["team.txt"], env, io())).toBe(2);
    files["small.txt"] = "Milotic\nAbility: Competitive\n- Scald";
    expect(await simCommand(["team.txt", "small.txt"], env, io())).toBe(1);
  }, 120_000);
});
