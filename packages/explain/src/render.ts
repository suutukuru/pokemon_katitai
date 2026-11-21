import type { Evidence, Finding } from "@ca/schema";
import { displayName, type Lang } from "@ca/data";
import { BASIS_JA, CATEGORY_JA, SEVERITY_JA, TEMPLATES_JA } from "./templates.ja.js";

const STAT_JA: Record<string, string> = {
  hp: "HP",
  atk: "こうげき",
  def: "ぼうぎょ",
  spa: "とくこう",
  spd: "とくぼう",
  spe: "すばやさ",
};
const WEATHER_JA: Record<string, string> = {
  Sun: "はれ",
  Rain: "あめ",
  Sand: "すなあらし",
  Snow: "ゆき",
};

type Params = Record<string, number | string | boolean>;

function formatValue(
  value: number | string | boolean,
  format: string | undefined,
  lang: Lang,
): string {
  const list = String(value)
    .split(",")
    .filter((x) => x !== "");
  const join = (xs: string[]) => xs.join(lang === "ja" ? "、" : ", ");
  switch (format) {
    case "species":
    case "moves":
    case "items":
    case "abilities":
      return join(list.map((id) => displayName(format, id, lang)));
    case "types":
      return join(list.map((t) => displayName("types", t.toLowerCase(), lang)));
    case "stat":
      return join(list.map((s) => STAT_JA[s] ?? s));
    case "weather":
      return join(list.map((w) => WEATHER_JA[w] ?? w));
    case "pairs": // "species:Type"
      return join(
        list.map((p) => {
          const [sp, t] = p.split(":");
          return `${displayName("species", sp!, lang)}（${displayName("types", (t ?? "").toLowerCase(), lang)}）`;
        }),
      );
    case "setters": // "species:abilityOrMove"
      return join(
        list.map((p) => {
          const [sp, x] = p.split(":");
          const label =
            displayName("abilities", x!, lang) !== x
              ? displayName("abilities", x!, lang)
              : displayName("moves", x!, lang);
          return `${displayName("species", sp!, lang)}の${label}`;
        }),
      );
    default:
      return typeof value === "number" ? String(value) : String(value);
  }
}

export function renderTemplate(template: string, params: Params, lang: Lang = "ja"): string {
  return template.replace(/\{(\w+)(?::(\w+))?\}/g, (_, key: string, format: string | undefined) => {
    if (!(key in params)) throw new Error(`template param "${key}" missing`);
    return formatValue(params[key]!, format, lang);
  });
}

export interface ExplainedFinding {
  severity: string;
  severityLabel: string;
  category: string;
  basis: Finding["basis"];
  basisLabel: string;
  title: string;
  body: string;
  evidence: { kind: Evidence["kind"]; label: string; lines: string[]; source?: string }[];
  suggestions: { title: string; body: string }[];
}

/** Render an evidence key/value: species/move/ability IDs and "species:x" pairs become names. */
function humanize(text: string, lang: Lang): string {
  if (WEATHER_JA[text]) return WEATHER_JA[text]!;
  const parts = text.split(",").filter((x) => x !== "");
  if (parts.length === 0) return text;
  const one = (p: string): string | undefined => {
    if (p.includes(":")) {
      const [a, b] = p.split(":") as [string, string];
      const sp = displayName("species", a, lang);
      if (sp === a) return undefined;
      const rest = [
        displayName("abilities", b, lang),
        displayName("moves", b, lang),
        displayName("types", b.toLowerCase(), lang),
      ].find((x) => x !== b && x !== b.toLowerCase());
      return `${sp}（${rest ?? b}）`;
    }
    for (const kind of ["species", "moves", "abilities", "items"] as const) {
      const n = displayName(kind, p, lang);
      if (n !== p) return n;
    }
    return undefined;
  };
  const named = parts.map(one);
  return named.every((x) => x !== undefined) ? named.join(lang === "ja" ? "、" : ", ") : text;
}

function evidenceLines(e: Evidence, lang: Lang): string[] {
  return Object.entries(e.values).map(([k, v]) => {
    const value =
      typeof v === "number"
        ? String(Math.round(v * 1000) / 1000)
        : typeof v === "string"
          ? humanize(v, lang)
          : String(v);
    return `${humanize(k, lang)}: ${value}`;
  });
}

/** Deterministic Japanese rendering of an engine Finding (no LLM). */
export function explainFinding(f: Finding, lang: Lang = "ja"): ExplainedFinding {
  const t = TEMPLATES_JA[f.explainKey];
  if (!t) throw new Error(`no template for "${f.explainKey}"`);
  return {
    severity: f.severity,
    severityLabel: SEVERITY_JA[f.severity],
    category: CATEGORY_JA[f.category] ?? f.category,
    basis: f.basis,
    basisLabel: BASIS_JA[f.basis],
    title: t.title,
    body: renderTemplate(t.body, f.params, lang),
    evidence: f.evidence.map((e) => ({
      kind: e.kind,
      label: e.label,
      lines: evidenceLines(e, lang),
      ...(e.kind === "data"
        ? { source: [e.source.title, e.snapshot].filter(Boolean).join(" / ") }
        : {}),
    })),
    suggestions: f.suggestions.map((s) => {
      const st = TEMPLATES_JA[s.explainKey];
      if (!st) throw new Error(`no template for "${s.explainKey}"`);
      return { title: st.title, body: renderTemplate(st.body, s.params, lang) };
    }),
  };
}

/**
 * Numbers an explanation may contain: those in the Finding's params/evidence/suggestions, plus the
 * fixed wording of its templates (e.g. "4倍弱点"). Used to validate optional LLM rewording.
 */
export function allowedNumbers(f: Finding): Set<string> {
  const out = new Set<string>();
  const fixed = [f.explainKey, ...f.suggestions.map((s) => s.explainKey)]
    .map((k) => TEMPLATES_JA[k])
    .map((t) => (t ? `${t.title} ${t.body}`.replace(/\{[^}]*\}/g, "") : ""));
  for (const text of fixed) for (const m of text.match(/\d+(?:\.\d+)?/g) ?? []) out.add(m);
  const add = (v: unknown) => {
    if (typeof v === "number") out.add(String(Math.round(v * 1000) / 1000));
    if (typeof v === "string") for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) out.add(m);
  };
  for (const v of Object.values(f.params)) add(v);
  for (const e of f.evidence) for (const v of Object.values(e.values)) add(v);
  for (const s of f.suggestions) for (const v of Object.values(s.params)) add(v);
  return out;
}

/**
 * Guard for optional LLM rewording (ADR-0004): reject text that contains any number
 * not present in the engine output. Returns the text, or undefined to fall back to the template.
 */
export function validateLlmText(text: string, f: Finding): string | undefined {
  const allowed = allowedNumbers(f);
  const found = text.normalize("NFKC").match(/\d+(?:\.\d+)?/g) ?? [];
  return found.every((n) => allowed.has(n) || allowed.has(String(Number(n)))) ? text : undefined;
}
