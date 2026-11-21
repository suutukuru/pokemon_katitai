import type { SetDelta } from "@ca/schema";

export function applySetDelta(parent: readonly string[] | undefined, delta: SetDelta): string[] {
  const out = new Set(parent ?? []);
  for (const a of delta.add) out.add(a);
  for (const r of delta.remove) out.delete(r);
  return [...out].sort();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge key-by-key, arrays and scalars replace. `undefined` is ignored. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/**
 * Merge an ID-keyed override record. `null` in the patch deletes the parent's entry;
 * otherwise entries are deep-merged field by field.
 */
export function mergeRecord<V>(
  base: Record<string, V>,
  patch: Record<string, V | null>,
): Record<string, V> {
  const out: Record<string, V> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (v === null) delete out[k];
    else out[k] = prev !== undefined ? deepMerge(prev, v) : v;
  }
  return out;
}

/** JSON with object keys sorted recursively — stable input for hashing and snapshots. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}
