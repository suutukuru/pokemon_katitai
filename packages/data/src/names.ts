import {
  I18nNamesSchema,
  MoveMetaSchema,
  toID,
  type I18nNames,
  type MoveMeta,
  type NameKind,
} from "@ca/schema";
import raw from "../i18n/names.json" with { type: "json" };
import rawMoves from "../base/moves.json" with { type: "json" };

let cachedMoves: MoveMeta | undefined;
/** Mainline move metadata (accuracy etc.) from PokeAPI; pack overrides apply on top. */
export function moveMeta(id: string): MoveMeta["moves"][string] | undefined {
  return (cachedMoves ??= MoveMetaSchema.parse(rawMoves)).moves[id];
}

let cached: I18nNames | undefined;
export function names(): I18nNames {
  return (cached ??= I18nNamesSchema.parse(raw));
}

export type Lang = "ja" | "en";

/** Display name for an ID, falling back to English and then the ID itself. */
export function displayName(kind: NameKind, id: string, lang: Lang = "ja"): string {
  const n = names()[kind][id];
  if (!n && kind === "species") {
    const mega = /^(.+?)mega([xyz]?)$/.exec(id);
    if (mega && names().species[mega[1]!]) {
      const base = displayName("species", mega[1]!, lang);
      const suffix = mega[2]!.toUpperCase();
      return lang === "ja" ? `メガ${base}${suffix}` : `${base}-Mega${suffix ? `-${suffix}` : ""}`;
    }
  }
  return (lang === "ja" ? n?.ja : undefined) ?? n?.en ?? id;
}

/**
 * Normalize for matching: NFKC (full-width → half-width), hiragana → katakana,
 * lowercase, drop spaces/punctuation. "リザードナイトＹ" and "りざーどないとy" match.
 */
export function normalizeName(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function levenshtein(a: string, b: string): number {
  const as = [...a];
  const bs = [...b];
  let prev = Array.from({ length: bs.length + 1 }, (_, i) => i);
  for (let i = 1; i <= as.length; i++) {
    const cur = [i];
    for (let j = 1; j <= bs.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (as[i - 1] === bs[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[bs.length]!;
}

export interface NameMatch {
  /** Best ID, or undefined if nothing is close enough. */
  id: string | undefined;
  /** exact: ID/name matched after normalization. fuzzy: closest by edit distance. */
  kind: "exact" | "fuzzy" | "none";
  /** 0..1 — 1 for exact, decreasing with edit distance. */
  confidence: number;
  /** Up to 5 candidates, best first (for the confirmation UI). */
  candidates: { id: string; label: string; distance: number }[];
}

export interface ResolveOptions {
  /** Restrict to these IDs (e.g. the regulation's legal species). */
  within?: ReadonlySet<string> | readonly string[];
  lang?: Lang;
}

interface IndexEntry {
  id: string;
  key: string;
}

const indexes = new Map<NameKind, IndexEntry[]>();
function indexFor(kind: NameKind): IndexEntry[] {
  let idx = indexes.get(kind);
  if (!idx) {
    idx = [];
    for (const [id, n] of Object.entries(names()[kind])) {
      const keys = new Set([id, normalizeName(n.en)]);
      if (n.ja) keys.add(normalizeName(n.ja));
      for (const key of keys) idx.push({ id, key });
    }
    indexes.set(kind, idx);
  }
  return idx;
}

/** Resolve free text (ja or en, any width/kana) to an ID, with fuzzy candidates. */
export function resolveName(kind: NameKind, text: string, options: ResolveOptions = {}): NameMatch {
  const within = options.within === undefined ? undefined : new Set(options.within);
  const allowed = (id: string) => within === undefined || within.has(id);
  const key = normalizeName(text);
  const label = (id: string) => displayName(kind, id, options.lang ?? "ja");
  if (key === "") return { id: undefined, kind: "none", confidence: 0, candidates: [] };

  const idx = indexFor(kind);
  const exact = idx.find((e) => allowed(e.id) && (e.key === key || e.id === toID(text)));
  if (exact) {
    return {
      id: exact.id,
      kind: "exact",
      confidence: 1,
      candidates: [{ id: exact.id, label: label(exact.id), distance: 0 }],
    };
  }
  // IDs not in the name table (e.g. Mega formes) still resolve by Showdown ID.
  if (within?.has(toID(text))) {
    const id = toID(text);
    return {
      id,
      kind: "exact",
      confidence: 1,
      candidates: [{ id, label: label(id), distance: 0 }],
    };
  }
  const best = new Map<string, number>();
  for (const e of idx) {
    if (!allowed(e.id)) continue;
    const d = levenshtein(key, e.key);
    if (d < (best.get(e.id) ?? Infinity)) best.set(e.id, d);
  }
  const candidates = [...best]
    .sort(([ia, a], [ib, b]) => a - b || ia.localeCompare(ib))
    .slice(0, 5)
    .map(([id, distance]) => ({ id, label: label(id), distance }));
  const top = candidates[0];
  const threshold = Math.max(1, Math.floor([...key].length / 3));
  if (!top || top.distance > threshold) {
    return { id: undefined, kind: "none", confidence: 0, candidates };
  }
  const confidence = Math.max(0.1, 1 - top.distance / Math.max(1, [...key].length));
  return { id: top.id, kind: "fuzzy", confidence: Math.round(confidence * 100) / 100, candidates };
}
