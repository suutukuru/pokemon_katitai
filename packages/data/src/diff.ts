import type { ResolvedPack } from "@ca/schema";
import { canonicalJson } from "./merge.js";

export interface SetChange {
  added: string[];
  removed: string[];
}
export interface RecordChange {
  added: string[];
  removed: string[];
  changed: string[];
}
export interface ValueChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface PackDiff {
  from: string;
  to: string;
  legal: Record<"species" | "megaSpecies" | "items" | "bannedMoves" | "bannedAbilities", SetChange>;
  mechanics: SetChange;
  overrides: Record<keyof ResolvedPack["overrides"], RecordChange>;
  rules: ValueChange[];
  weights: ValueChange[];
}

function setChange(a: readonly string[], b: readonly string[]): SetChange {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added: b.filter((x) => !sa.has(x)).sort(),
    removed: a.filter((x) => !sb.has(x)).sort(),
  };
}

function recordChange(a: Record<string, unknown>, b: Record<string, unknown>): RecordChange {
  const keys = setChange(Object.keys(a), Object.keys(b));
  const changed = Object.keys(a)
    .filter((k) => k in b && canonicalJson(a[k]) !== canonicalJson(b[k]))
    .sort();
  return { ...keys, changed };
}

function valueChanges(a: unknown, b: unknown, path = ""): ValueChange[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => valueChanges(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return canonicalJson(a) === canonicalJson(b) ? [] : [{ path, from: a, to: b }];
}

/** Structural difference between two resolved packs (b relative to a). */
export function diffPacks(a: ResolvedPack, b: ResolvedPack): PackDiff {
  const legalKeys = ["species", "megaSpecies", "items", "bannedMoves", "bannedAbilities"] as const;
  const ovKeys = ["species", "newSpecies", "moves", "abilities", "items"] as const;
  return {
    from: a.id,
    to: b.id,
    legal: Object.fromEntries(
      legalKeys.map((k) => [k, setChange(a.legal[k], b.legal[k])]),
    ) as PackDiff["legal"],
    mechanics: setChange(a.mechanics, b.mechanics),
    overrides: Object.fromEntries(
      ovKeys.map((k) => [k, recordChange(a.overrides[k], b.overrides[k])]),
    ) as PackDiff["overrides"],
    rules: valueChanges(a.rules, b.rules),
    weights: valueChanges(a.weights, b.weights),
  };
}

export function isEmptyDiff(d: PackDiff): boolean {
  const sets = [...Object.values(d.legal), d.mechanics];
  return (
    sets.every((s) => s.added.length === 0 && s.removed.length === 0) &&
    Object.values(d.overrides).every(
      (r) => r.added.length + r.removed.length + r.changed.length === 0,
    ) &&
    d.rules.length === 0 &&
    d.weights.length === 0
  );
}

/** Human-readable rendering for the CLI (`pnpm reg:diff`). */
export function formatDiff(d: PackDiff): string {
  const lines: string[] = [`差分: ${d.from} → ${d.to}`];
  const set = (label: string, s: SetChange) => {
    if (s.added.length) lines.push(`  + ${label}: ${s.added.join(", ")}`);
    if (s.removed.length) lines.push(`  - ${label}: ${s.removed.join(", ")}`);
  };
  set("使用可能ポケモン", d.legal.species);
  set("メガシンカ可能", d.legal.megaSpecies);
  set("使用可能な持ち物", d.legal.items);
  set("禁止技", d.legal.bannedMoves);
  set("禁止特性", d.legal.bannedAbilities);
  set("仕組み(mechanics)", d.mechanics);
  for (const [k, r] of Object.entries(d.overrides)) {
    if (r.added.length) lines.push(`  + 調整(${k}): ${r.added.join(", ")}`);
    if (r.removed.length) lines.push(`  - 調整(${k}): ${r.removed.join(", ")}`);
    if (r.changed.length) lines.push(`  ~ 調整(${k}): ${r.changed.join(", ")}`);
  }
  for (const c of d.rules)
    lines.push(`  ~ ルール ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  for (const c of d.weights)
    lines.push(`  ~ 重み ${c.path}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  if (isEmptyDiff(d)) lines.push("  (差分なし)");
  return lines.join("\n");
}
