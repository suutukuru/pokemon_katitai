import { STAT_IDS, type GameSpec, type PokemonSet, type ResolvedPack } from "@ca/schema";
import { displayName, normalizeName } from "@ca/data";
import { ChampionsCalc, validateSp, type Weather } from "@ca/calc";
import { parseShowdown } from "@ca/ingest";
import type { Io } from "./commands.js";

const STAT_JA = {
  hp: "HP",
  atk: "こうげき",
  def: "ぼうぎょ",
  spa: "とくこう",
  spd: "とくぼう",
  spe: "すばやさ",
} as const;
const WEATHER_JA: Record<string, string> = {
  Sun: "はれ",
  Rain: "あめ",
  Sand: "すなあらし",
  Snow: "ゆき",
};
const SEVERITY_JA = { error: "エラー", warning: "確認", info: "情報" } as const;

export interface TeamEnv {
  pack: ResolvedPack;
  spec: GameSpec;
  readText(path: string): string;
}

function load(path: string, env: TeamEnv, io: Io) {
  const r = parseShowdown(env.readText(path), {
    legal: { species: env.pack.legal.species, items: env.pack.legal.items },
  });
  for (const i of r.issues) {
    const where = [i.line !== undefined ? `${i.line}行目` : "", i.field ?? ""]
      .filter(Boolean)
      .join(" ");
    const cand = i.candidates?.length
      ? `（候補: ${i.candidates.map((c) => c.label).join(" / ")}）`
      : "";
    io.err(`[${SEVERITY_JA[i.severity]}] ${where ? where + ": " : ""}${i.message}${cand}`);
  }
  return r;
}

/** `team:check <file>` — parse a team and print the Champions stats of each member. */
export function teamCheck(args: string[], env: TeamEnv, io: Io): number {
  const path = args[0];
  if (!path) {
    io.err("usage: pnpm team:check <team.txt>");
    return 2;
  }
  const r = load(path, env, io);
  const calc = new ChampionsCalc(env.pack, env.spec);
  io.out(
    `レギュレーション ${env.pack.id}（データ ${env.pack.dataVersion} / ${env.pack.contentHash}）`,
  );
  for (const m of r.members) {
    const s = calc.stats({ set: m });
    const total = STAT_IDS.reduce((a, k) => a + m.sp[k], 0);
    io.out(
      `\n${displayName("species", m.species)} @ ${m.item ? displayName("items", m.item) : "なし"} / ${displayName("abilities", m.ability)} / ${displayName("natures", m.nature.toLowerCase())}`,
    );
    io.out(
      "  " +
        STAT_IDS.map((k) => `${STAT_JA[k]} ${s[k]}(${m.sp[k]})`).join("  ") +
        `  SP合計 ${total}`,
    );
    io.out("  技: " + m.moves.map((x) => displayName("moves", x)).join(" / "));
    for (const i of validateSp(env.spec, m.sp)) io.err(`  [エラー] ${i.message}`);
    if (m.assumed.length) io.out(`  ※仮の値: ${m.assumed.join(", ")}`);
  }
  return r.issues.some((i) => i.severity === "error") ? 1 : 0;
}

function pick(members: PokemonSet[], query: string): PokemonSet | undefined {
  const q = normalizeName(query);
  return members.find(
    (m) =>
      normalizeName(displayName("species", m.species, "ja")) === q ||
      normalizeName(displayName("species", m.species, "en")) === q ||
      m.species === q ||
      (m.nickname !== undefined && normalizeName(m.nickname) === q),
  );
}

/**
 * `calc <team.txt> <attacker> <move> <defender> [--mega] [--weather Sun|Rain|Sand|Snow] [--def-team other.txt]`
 * Attacker/defender are looked up in the team file(s) by Japanese/English name or nickname.
 */
export function calcCommand(args: string[], env: TeamEnv, io: Io): number {
  const flags = new Set(args.filter((a) => a === "--mega" || a === "--def-mega"));
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !["--weather", "--def-team"].includes(args[i - 1] ?? ""),
  );
  const [file, atkName, moveName, defName] = positional;
  if (!file || !atkName || !moveName || !defName) {
    io.err(
      "usage: pnpm calc <team.txt> <攻撃側> <技> <防御側> [--mega] [--def-mega] [--weather Sun] [--def-team 相手.txt]",
    );
    return 2;
  }
  const mine = load(file, env, io).members;
  const defTeam = opt("def-team");
  const theirs = defTeam ? load(defTeam, env, io).members : mine;
  const atk = pick(mine, atkName);
  const def = pick(theirs, defName);
  if (!atk || !def) {
    io.err(`ポケモンが見つかりません: ${!atk ? atkName : defName}`);
    return 1;
  }
  const move = atk.moves.find(
    (m) =>
      m === normalizeName(moveName) ||
      normalizeName(displayName("moves", m)) === normalizeName(moveName) ||
      normalizeName(displayName("moves", m, "en")) === normalizeName(moveName),
  );
  if (!move) {
    io.err(
      `${displayName("species", atk.species)} は「${moveName}」を覚えていません（${atk.moves.map((m) => displayName("moves", m)).join(" / ")}）`,
    );
    return 1;
  }
  const weather = opt("weather") as Weather | undefined;
  const calc = new ChampionsCalc(env.pack, env.spec);
  const r = calc.damage(
    { set: atk, mega: flags.has("--mega") },
    { set: def, mega: flags.has("--def-mega") },
    move,
    weather ? { weather } : {},
  );
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  io.out(
    `${calc.label(calc.formeOf({ set: atk, mega: flags.has("--mega") }))} の ${displayName("moves", move)} → ${calc.label(calc.formeOf({ set: def, mega: flags.has("--def-mega") }))}${weather ? `（天気: ${WEATHER_JA[weather] ?? weather}）` : ""}`,
  );
  io.out(
    `  ダメージ ${r.min}〜${r.max}（${r.percent[0]}%〜${r.percent[1]}%） / 相手HP ${r.defenderHp}`,
  );
  io.out(
    `  1発で倒す確率: 急所なし ${pct(r.ohko.noCrit)} / 急所 ${pct(r.ohko.crit)} / 命中${pct(r.accuracy)}・急所率込み ${pct(r.koChanceOneHit)}`,
  );
  if (r.nhko.n > 0)
    io.out(
      `  確定数: ${r.nhko.n}発${r.nhko.chance !== undefined && r.nhko.chance < 1 ? `（乱数 ${pct(r.nhko.chance)}）` : "（確定）"}`,
    );
  io.out(
    `  根拠: 攻撃側 ${r.attackerStats.atk}/${r.attackerStats.spa}（こうげき/とくこう）・防御側 ${r.defenderStats.def}/${r.defenderStats.spd}（ぼうぎょ/とくぼう）・レギュレーション ${env.pack.id} ${env.pack.contentHash}`,
  );
  return 0;
}
