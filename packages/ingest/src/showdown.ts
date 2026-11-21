import {
  PokemonSetSchema,
  STAT_IDS,
  type PokemonSet,
  type StatId,
  type StatsTable,
} from "@ca/schema";
import { displayName, names, resolveName, type NameMatch } from "@ca/data";
import { evToSp } from "@ca/calc";
import type { ExtractContext, ExtractionResult, Extractor, IngestIssue } from "./extractor.js";

const STAT_ALIASES: Record<string, StatId> = {
  hp: "hp",
  h: "hp",
  atk: "atk",
  attack: "atk",
  a: "atk",
  こうげき: "atk",
  攻撃: "atk",
  def: "def",
  defense: "def",
  b: "def",
  ぼうぎょ: "def",
  防御: "def",
  spa: "spa",
  spatk: "spa",
  "spatk.": "spa",
  c: "spa",
  とくこう: "spa",
  特攻: "spa",
  spd: "spd",
  spdef: "spd",
  d: "spd",
  とくぼう: "spd",
  特防: "spd",
  spe: "spe",
  speed: "spe",
  s: "spe",
  すばやさ: "spe",
  素早さ: "spe",
};

function parseStatLine(text: string): Partial<StatsTable> | undefined {
  const out: Partial<StatsTable> = {};
  for (const part of text.split("/")) {
    const m = /^\s*(\d+)\s*(.+?)\s*$/.exec(part.normalize("NFKC"));
    if (!m) return undefined;
    const stat = STAT_ALIASES[m[2]!.toLowerCase().replace(/\s+/g, "")];
    if (!stat) return undefined;
    out[stat] = Number(m[1]);
  }
  return out;
}

const fill = (p: Partial<StatsTable>): StatsTable =>
  Object.fromEntries(STAT_IDS.map((s) => [s, p[s] ?? 0])) as StatsTable;

interface Draft {
  startLine: number;
  species?: string;
  nickname?: string;
  gender?: "M" | "F";
  item?: string;
  ability?: string;
  nature?: string;
  sp?: StatsTable;
  moves: string[];
  confidence: Record<string, number>;
  assumed: string[];
}

/**
 * Parse Showdown / PokéPaste text. Extensions for Champions:
 * - `SPs: 32 HP / 2 Atk / 32 Spe` sets stat points directly.
 * - `EVs:` lines are converted to SP (EV 8n-4 ⇔ SP n) with a warning.
 * - Names may be Japanese (any kana/width); fuzzy matches lower confidence and add candidates.
 */
export function parseShowdown(text: string, ctx: ExtractContext = {}): ExtractionResult {
  const issues: IngestIssue[] = [];
  const drafts: Draft[] = [];
  let cur: Draft | undefined;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.normalize("NFKC").trim();
    if (line === "") {
      cur = undefined;
      return;
    }
    if (!cur) {
      cur = { startLine: lineNo, moves: [], confidence: {}, assumed: [] };
      drafts.push(cur);
      parseHeader(line, cur);
      return;
    }
    const kv = /^([^:]+):\s*(.*)$/.exec(line);
    if (line.startsWith("-")) {
      cur.moves.push(line.replace(/^-\s*/, ""));
    } else if (/^(.+?)\s+Nature$/i.test(line)) {
      cur.nature = /^(.+?)\s+Nature$/i.exec(line)![1]!;
    } else if (/^性格\s*[:：]/.test(rawLine.trim())) {
      cur.nature = line.replace(/^性格\s*:\s*/, "");
    } else if (kv) {
      const key = kv[1]!.trim().toLowerCase();
      const value = kv[2]!.trim();
      if (key === "ability" || key === "特性") cur.ability = value;
      else if (key === "sps" || key === "sp") {
        const sp = parseStatLine(value);
        if (sp) cur.sp = fill(sp);
        else
          issues.push({
            severity: "error",
            line: lineNo,
            field: "sp",
            message: `SPs の行を読めません: "${value}"`,
          });
      } else if (key === "evs") {
        const ev = parseStatLine(value);
        if (ev) {
          cur.sp = fill(Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, evToSp(v)])));
          cur.confidence["sp"] = 0.9;
          issues.push({
            severity: "warning",
            line: lineNo,
            field: "sp",
            member: drafts.length - 1,
            message:
              "EVs を SP に換算しました（SP n ⇔ EV 8n-4）。合計が66にならない場合は調整してください",
          });
        } else
          issues.push({
            severity: "error",
            line: lineNo,
            field: "sp",
            message: `EVs の行を読めません: "${value}"`,
          });
      } else if (
        ["level", "ivs", "tera type", "shiny", "happiness", "dynamax level", "gigantamax"].includes(
          key,
        )
      ) {
        issues.push({
          severity: "info",
          line: lineNo,
          message: `"${kv[1]}" は Champions では使わないため無視しました`,
        });
      } else {
        issues.push({
          severity: "warning",
          line: lineNo,
          message: `不明な行を無視しました: "${line}"`,
        });
      }
    } else {
      issues.push({
        severity: "warning",
        line: lineNo,
        message: `不明な行を無視しました: "${line}"`,
      });
    }
  });

  const members: PokemonSet[] = [];
  drafts.forEach((d, idx) => {
    const set = finalize(d, idx, ctx, issues);
    if (set) members.push(set);
  });
  if (members.length > 6)
    issues.push({ severity: "error", message: `ポケモンが${members.length}体あります（最大6体）` });
  return { extractor: "showdown-text", members, issues };
}

function parseHeader(line: string, d: Draft): void {
  let rest = line;
  const at = rest.split(" @ ");
  if (at.length > 1) {
    d.item = at.slice(1).join(" @ ").trim();
    rest = at[0]!.trim();
  }
  const g = /\s*\((M|F)\)\s*$/.exec(rest);
  if (g) {
    d.gender = g[1] as "M" | "F";
    rest = rest.slice(0, g.index).trim();
  }
  const nick = /^(.*?)\s*\(([^()]+)\)$/.exec(rest);
  if (nick && nick[1]) {
    d.nickname = nick[1];
    d.species = nick[2]!;
  } else d.species = rest;
}

function resolveField(
  kind: "species" | "items" | "abilities" | "moves" | "natures",
  text: string,
  field: string,
  member: number,
  line: number,
  d: Draft,
  issues: IngestIssue[],
  within?: readonly string[],
): string | undefined {
  const m: NameMatch = resolveName(kind, text, within ? { within } : {});
  const candidates = m.candidates.map(({ id, label }) => ({ id, label }));
  if (m.kind === "none" || m.id === undefined) {
    issues.push({
      severity: "error",
      member,
      field,
      line,
      message: `「${text}」が見つかりません`,
      candidates,
    });
    return undefined;
  }
  if (m.kind === "fuzzy") {
    d.confidence[field] = m.confidence;
    issues.push({
      severity: "warning",
      member,
      field,
      line,
      message: `「${text}」を「${displayName(kind, m.id)}」と読み替えました。違う場合は候補から選んでください`,
      candidates,
    });
  }
  return m.id;
}

function finalize(
  d: Draft,
  idx: number,
  ctx: ExtractContext,
  issues: IngestIssue[],
): PokemonSet | undefined {
  const line = d.startLine;
  let species = d.species
    ? resolveField("species", d.species, "species", idx, line, d, issues, ctx.legal?.species)
    : undefined;
  if (!species) return undefined;
  // Gender-dependent formes (Indeedee-F, Basculegion-F, Meowstic-F): "(F)" selects the female forme.
  const female = `${species}f`;
  if (
    d.gender === "F" &&
    names().species[female] &&
    (!ctx.legal?.species || ctx.legal.species.includes(female))
  ) {
    species = female;
  }
  const item = d.item
    ? resolveField("items", d.item, "item", idx, line, d, issues, ctx.legal?.items)
    : undefined;
  const ability = d.ability
    ? resolveField("abilities", d.ability, "ability", idx, line, d, issues)
    : undefined;
  let nature = d.nature
    ? resolveField("natures", d.nature, "nature", idx, line, d, issues)
    : undefined;
  const moves = d.moves
    .map((m, i) => resolveField("moves", m, `moves.${i}`, idx, line, d, issues))
    .filter((m): m is string => m !== undefined);

  if (!ability) {
    issues.push({
      severity: "error",
      member: idx,
      field: "ability",
      line,
      message: "特性がありません",
    });
    return undefined;
  }
  if (moves.length === 0) {
    issues.push({
      severity: "error",
      member: idx,
      field: "moves",
      line,
      message: "技がありません",
    });
    return undefined;
  }
  // Unread values are filled with placeholders and flagged `assumed` (phase 3: usage-based fill).
  if (!nature) {
    nature = "serious";
    d.assumed.push("nature");
    issues.push({
      severity: "warning",
      member: idx,
      field: "nature",
      line,
      message: "性格が無いため無補正（まじめ）と仮定しました",
    });
  }
  if (!d.sp) {
    d.assumed.push("sp");
    issues.push({
      severity: "warning",
      member: idx,
      field: "sp",
      line,
      message: "SP 配分が無いため全て0と仮定しました",
    });
  }
  const r = PokemonSetSchema.safeParse({
    species,
    ...(d.nickname ? { nickname: d.nickname } : {}),
    ...(item ? { item } : {}),
    ability,
    nature: natureName(nature),
    sp: d.sp ?? fill({}),
    moves,
    ...(d.gender ? { gender: d.gender } : {}),
    confidence: d.confidence,
    assumed: d.assumed,
  });
  if (!r.success) {
    issues.push({
      severity: "error",
      member: idx,
      line,
      message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return undefined;
  }
  return r.data;
}

function natureName(id: string): string {
  return displayName("natures", id, "en");
}

/** Showdown text with the `SPs:` extension (lossless round trip with {@link parseShowdown}). */
export function formatShowdown(sets: readonly PokemonSet[], lang: "en" | "ja" = "en"): string {
  const name = (kind: "species" | "items" | "abilities" | "moves", id: string) =>
    displayName(kind, id, lang);
  const labels: Record<StatId, string> = {
    hp: "HP",
    atk: "Atk",
    def: "Def",
    spa: "SpA",
    spd: "SpD",
    spe: "Spe",
  };
  return sets
    .map((s) => {
      const species = name("species", s.species);
      const head = [
        s.nickname ? `${s.nickname} (${species})` : species,
        s.gender && s.gender !== "N" ? `(${s.gender})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const lines = [
        s.item ? `${head} @ ${name("items", s.item)}` : head,
        `Ability: ${name("abilities", s.ability)}`,
      ];
      const sp = STAT_IDS.filter((k) => s.sp[k] > 0).map((k) => `${s.sp[k]} ${labels[k]}`);
      if (sp.length) lines.push(`SPs: ${sp.join(" / ")}`);
      lines.push(`${s.nature} Nature`);
      for (const m of s.moves) lines.push(`- ${name("moves", m)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export class ShowdownTextExtractor implements Extractor<string> {
  readonly id = "showdown-text";
  extract(input: string, ctx?: ExtractContext): Promise<ExtractionResult> {
    return Promise.resolve(parseShowdown(input, ctx));
  }
}
