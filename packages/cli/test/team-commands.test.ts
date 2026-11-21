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
    const d = io();
    metaCommand([], readTeamDbFiles(), env.pack.legal.species, d, env.pack.seasons);
    expect(d.o[0]).toContain("上位構築 22件（M-6, M-7・ダブル）");
  });
});

describe("sim", () => {
  it("runs a tiny-budget matchup and prints selection, matrix and turn-1 sections", async () => {
    const { simCommand } = await import("../src/index.js");
    const tiny = structuredClone(env.pack);
    Object.assign(tiny.weights.simulation, {
      screenBattles: 1,
      screenKeep: 0,
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

describe("sim with resolved opponents and sim:meta", () => {
  it("uses resolveTeam for pokedb specs and summarises sim:meta", async () => {
    const { simCommand, simMetaCommand } = await import("../src/index.js");
    const tiny = structuredClone(env.pack);
    Object.assign(tiny.weights.simulation, {
      screenBattles: 1,
      screenKeep: 0,
      topConfigs: 2,
      matrixBattles: 1,
      turnOptions: 2,
      turnRollouts: 1,
      fictitiousIterations: 200,
    });
    const { parseShowdown } = await import("@ca/ingest");
    const rain = parseShowdown(
      files["rain.txt"] ??
        readFileSync(new URL("../../data/teams/samples/sample-rain.txt", import.meta.url), "utf8"),
    ).members;
    const simEnv = {
      ...env,
      pack: tiny,
      resolveTeam: (spec: string) =>
        spec === "pokedb:M-7:4"
          ? { members: rain, label: "M-7 4位", note: "推定", missing: ["audino"] }
          : undefined,
      topTeams: () => ["pokedb:M-7:4", "pokedb:M-0:0"],
    };
    const x = io();
    expect(await simCommand(["team.txt", "pokedb:M-7:4"], simEnv, x)).toBe(0);
    expect(x.e[0]).toBe("[M-7 4位] 推定");
    const y = io();
    expect(await simMetaCommand(["team.txt", "--top", "2", "--scale", "0.01"], simEnv, y)).toBe(0);
    const out = y.o.join("\n");
    expect(out).toContain("■ M-7 4位");
    expect(out).toContain("推奨選出:");
    expect(out).toContain("型を推定できず除外: タブンネ");
    expect(y.e.some((l) => l.startsWith("skip pokedb:M-0:0"))).toBe(true);
    expect(await simMetaCommand([], env, io())).toBe(2);
  }, 180_000);
});

describe("renderMetaReport", () => {
  it("renders hardest matchups first with text verdicts (not color only) and escapes input", async () => {
    const { renderMetaReport } = await import("../src/index.js");
    const row = (label: string, winRate: number) => ({
      spec: "s",
      label,
      opponent: ["pelipper"],
      missing: [],
      winRate,
      safestRate: winRate - 0.1,
      bring: ["charizard", "whimsicott", "aerodactyl", "milotic"],
      turnOne: "リザードン:ねっぷう",
      isGuess: true,
      battles: 100,
    });
    const html = renderMetaReport({
      teamName: "t<1>",
      regulation: "M-C",
      mine: ["charizard"],
      rows: [row("A", 0.7), row("B", 0.2), row("C", 0.5)],
      date: "2026-11-21",
      usageSource: "x",
    });
    expect(html.indexOf("B</span>")).toBeLessThan(html.indexOf("A</span>"));
    expect(html).toContain("▼ 不利");
    expect(html).toContain("▲ 有利");
    expect(html).toContain("● 五分");
    expect(html).toContain("t&lt;1&gt;");
    expect(html).toContain("先発 <b>リザードン・エルフーン</b>");
    expect(html).toContain("300戦");
  });
});

describe("battle report", () => {
  it("renders events in Japanese and decisions with scores and probabilities", async () => {
    const { eventLines, renderBattleReport } = await import("../src/index.js");
    const lines = eventLines([
      { t: "move", side: 0, who: "charizard", move: "heatwave", spread: true },
      { t: "super", side: 1, who: "whimsicott" },
      { t: "crit", side: 1, who: "whimsicott" },
      { t: "damage", side: 1, who: "whimsicott", hp: 0 },
      { t: "faint", side: 1, who: "whimsicott" },
      { t: "damage", side: 0, who: "charizard", hp: 90, from: "lifeorb" },
      { t: "weather", weather: "SunnyDay", upkeep: false },
      { t: "weather", weather: "SunnyDay", upkeep: true },
      { t: "sidestart", side: 0, cond: "tailwind" },
      { t: "cant", side: 1, who: "milotic", reason: "par" },
      { t: "boost", side: 1, who: "archaludon", stat: "def", n: 1 },
      { t: "protected", side: 0, who: "whimsicott" },
      { t: "miss", side: 1, who: "milotic" },
    ]);
    const text = lines.join("\n").replace(/<[^>]+>/g, "");
    expect(text).toContain("リザードン の ねっぷう（全体）");
    expect(text).toContain("エルフーン 残りHP 0% ばつぐん・急所");
    expect(text).toContain("いのちのたま");
    expect(text.match(/天気: はれ/g)).toHaveLength(1);
    expect(text).toContain("自分のおいかぜが始まった");
    expect(text).toContain("動けない（まひ）");
    const opt = { choice: "move 1 mega", moveId: "heatwave", score: 1.234 };
    const html = renderBattleReport({
      title: "t",
      summary: "30戦",
      params: { koBonus: 0.6, temperature: 0.35 },
      log: {
        seed: 1,
        result: { winner: 1, turns: 1, remaining: [0, 2] },
        brought: [["charizard"], ["pelipper"]],
        turns: [
          {
            turn: 1,
            events: [],
            hp: [],
            decisions: [
              {
                turn: 1,
                side: 0,
                species: "charizard",
                hpPct: 100,
                chosen: 0,
                options: [{ option: opt, prob: 0.9 }],
              },
            ],
          },
        ],
      },
    });
    expect(html).toContain("負け（1ターン");
    expect(html).toContain("✔ ねっぷう（メガ）");
    expect(html).toContain("1.23");
    expect(html).toContain("90%");
    expect(html).toContain("相手 0.35");
  });
});

describe("replay page", () => {
  it("embeds the data, a name table and the controls in one file", async () => {
    const { renderReplayPage, renderReplayBook } = await import("../src/index.js");
    const html = renderReplayPage({
      title: "t<x>",
      subtitle: "s",
      params: { koBonus: 0.6 },
      data: {
        seed: 1,
        rollouts: 4,
        result: { winner: 0, turns: 1, remaining: [1, 0] },
        brought: [["charizard"], ["pelipper"]],
        members: [
          { side: 0, species: "charizard", maxhp: 175 },
          { side: 1, species: "pelipper", maxhp: 137 },
        ],
        turns: [
          {
            turn: 0,
            decisions: [],
            events: [{ t: "switch", side: 0, who: "charizard", hp: 100, slot: 0 }],
          },
          {
            turn: 1,
            decisions: [],
            events: [
              { t: "move", side: 0, who: "charizard", move: "heatwave", spread: true },
              { t: "faint", side: 1, who: "pelipper" },
            ],
            whatIf: [
              {
                choice: "move 1",
                slots: [{ species: "charizard", moveId: "heatwave", mega: false }],
                winRate: 0.75,
                games: 4,
                ci: [0.3, 0.95],
                chosen: true,
              },
            ],
          },
        ],
      },
    });
    expect(html).toContain("<title>t&lt;x&gt;</title>");
    expect(html).toContain('"s:charizard":"リザードン"');
    expect(html).toContain('"m:heatwave":"ねっぷう"');
    expect(html).toContain('id="seek"');
    expect(html).not.toMatch(/<script[^>]+src=/); // no external scripts
    const data = JSON.parse(
      html.match(/<script id="payload" type="application\/json">(.*?)<\/script>/s)![1]!,
    ).books[0].d;
    const book = renderReplayBook({
      title: "b",
      subtitle: "s",
      params: {},
      entries: [
        { label: "M-7 4位", subtitle: "x", opponent: ["pelipper", "archaludon"], data },
        {
          label: "M-7 27位",
          subtitle: "y",
          opponent: ["kingambit"],
          data: { ...data, mode: "best" },
        },
      ],
    });
    const payload = JSON.parse(
      book.match(/<script id="payload" type="application\/json">(.*?)<\/script>/s)![1]!,
    );
    expect(payload.books.map((b: { label: string }) => b.label)).toEqual(["M-7 4位", "M-7 27位"]);
    expect(payload.n["s:archaludon"]).toBe("ブリジュラス");
    expect(payload.n["s:kingambit"]).toBe("ドドゲザン");
    const { toArtifactPage } = await import("../src/index.js");
    const art = toArtifactPage(book, "M-C 対戦ブック");
    expect(art.startsWith("<title>M-C 対戦ブック</title>")).toBe(true);
    expect(art).not.toMatch(/<!doctype|<html|<head|<body/i);
    expect(art).toContain('content="cover"');
    expect(art).toContain('id="payload"');
  });
});
