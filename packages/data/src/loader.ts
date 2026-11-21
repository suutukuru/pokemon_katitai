import {
  LegalDeltaSchema,
  ManifestSchema,
  OverridesDeltaSchema,
  ResolvedPackSchema,
  RulesDeltaSchema,
  RulesSchema,
  WeightsDeltaSchema,
  WeightsSchema,
  type LegalDelta,
  type Manifest,
  type OverridesDelta,
  type ResolvedPack,
  type SetDelta,
} from "@ca/schema";
import type { z } from "zod";
import { baseDex, dexWithNewSpecies, type Dex } from "./dex.js";
import { applySetDelta, canonicalJson, deepMerge, mergeRecord } from "./merge.js";
import { sha256Hex } from "./sha256.js";
import type { PackFile, PackSource } from "./source.js";

export interface PackIssue {
  packId: string;
  file: PackFile | "chain" | "resolved";
  path: string;
  message: string;
}

export class PackValidationError extends Error {
  constructor(
    readonly packId: string,
    readonly issues: readonly PackIssue[],
  ) {
    super(
      `Regulation pack "${packId}" is invalid (${issues.length} issue(s)):\n` +
        issues
          .map((i) => `  - [${i.packId}/${i.file}] ${i.path || "(root)"}: ${i.message}`)
          .join("\n"),
    );
    this.name = "PackValidationError";
  }
}

export interface LoadOptions {
  dex?: Dex;
  /** Mechanic plugin IDs registered in the engine. If given, unknown IDs are errors. */
  knownMechanics?: readonly string[];
}

interface ParsedPack {
  id: string;
  manifest: Manifest;
  legal: LegalDelta;
  overrides: OverridesDelta;
  rules: unknown;
  weights: unknown;
}

const LEGAL_SETS = ["species", "megaSpecies", "items", "bannedMoves", "bannedAbilities"] as const;
type LegalSetKey = (typeof LEGAL_SETS)[number];

function zodIssues(packId: string, file: PackFile, err: z.ZodError): PackIssue[] {
  return err.issues.map((i) => ({
    packId,
    file,
    path: i.path.map(String).join("."),
    message: i.message,
  }));
}

function parseFile<T>(
  source: PackSource,
  packId: string,
  file: PackFile,
  schema: z.ZodType<T>,
  issues: PackIssue[],
  fallback: unknown,
): T | undefined {
  let raw: unknown;
  try {
    raw = source.read(packId, file);
  } catch (e) {
    issues.push({ packId, file, path: "", message: `cannot read: ${(e as Error).message}` });
    return undefined;
  }
  const r = schema.safeParse(raw ?? fallback);
  if (!r.success) {
    issues.push(...zodIssues(packId, file, r.error));
    return undefined;
  }
  return r.data;
}

/** Follow `extends` from `id` up to the root. Returned root-first. */
function resolveChain(
  source: PackSource,
  id: string,
  issues: PackIssue[],
): ParsedPack[] | undefined {
  const known = new Set(source.listPackIds());
  const leafFirst: ParsedPack[] = [];
  const seen: string[] = [];
  let cur: string | undefined = id;
  while (cur !== undefined) {
    if (seen.includes(cur)) {
      issues.push({
        packId: id,
        file: "chain",
        path: "extends",
        message: `circular inheritance: ${[...seen, cur].join(" → ")}`,
      });
      return undefined;
    }
    if (!known.has(cur)) {
      const child = seen.at(-1);
      issues.push({
        packId: child ?? cur,
        file: child ? "manifest" : "chain",
        path: child ? "extends" : "",
        message: child ? `parent pack "${cur}" does not exist` : `pack "${cur}" does not exist`,
      });
      return undefined;
    }
    seen.push(cur);
    const before = issues.length;
    const manifest: Manifest | undefined = parseFile(
      source,
      cur,
      "manifest",
      ManifestSchema,
      issues,
      undefined,
    );
    const legal = parseFile(source, cur, "legal", LegalDeltaSchema, issues, {});
    const overrides = parseFile(source, cur, "overrides", OverridesDeltaSchema, issues, {});
    const isRoot = manifest?.extends === undefined;
    const rules = parseFile(
      source,
      cur,
      "rules",
      (isRoot ? RulesSchema : RulesDeltaSchema) as z.ZodType<unknown>,
      issues,
      isRoot ? undefined : {},
    );
    const weights = parseFile(
      source,
      cur,
      "weights",
      (isRoot ? WeightsSchema : WeightsDeltaSchema) as z.ZodType<unknown>,
      issues,
      isRoot ? undefined : {},
    );
    if (manifest && manifest.id !== cur) {
      issues.push({
        packId: cur,
        file: "manifest",
        path: "id",
        message: `id "${manifest.id}" does not match directory "${cur}"`,
      });
    }
    if (issues.length > before || !manifest || !legal || !overrides) return undefined;
    leafFirst.push({ id: cur, manifest, legal, overrides, rules, weights });
    cur = manifest.extends;
  }
  return leafFirst.reverse();
}

function checkDelta(
  pack: string,
  file: PackFile,
  key: string,
  delta: SetDelta,
  parent: readonly string[] | undefined,
  exists: (id: string) => boolean,
  kind: string,
  issues: PackIssue[],
): void {
  delta.add.forEach((id, i) => {
    if (!exists(id))
      issues.push({
        packId: pack,
        file,
        path: `${key}.add.${i}`,
        message: `unknown ${kind} "${id}"`,
      });
  });
  delta.remove.forEach((id, i) => {
    if (parent === undefined) {
      issues.push({
        packId: pack,
        file,
        path: `${key}.remove.${i}`,
        message: `root pack cannot remove "${id}"`,
      });
    } else if (!parent.includes(id)) {
      issues.push({
        packId: pack,
        file,
        path: `${key}.remove.${i}`,
        message: `"${id}" is not present in the parent pack`,
      });
    }
  });
}

/**
 * Load and resolve a regulation pack, applying `extends` inheritance.
 * Throws {@link PackValidationError} with every issue found (schema, references, inheritance).
 */
export function loadPack(source: PackSource, id: string, options: LoadOptions = {}): ResolvedPack {
  const issues: PackIssue[] = [];
  const chain = resolveChain(source, id, issues);
  if (!chain) throw new PackValidationError(id, issues);

  const base = options.dex ?? baseDex();
  let legal: Record<LegalSetKey, string[]> | undefined;
  let mechanics: string[] | undefined;
  let overrides: ResolvedPack["overrides"] = {
    species: {},
    newSpecies: {},
    moves: {},
    abilities: {},
    items: {},
  };
  let rules: unknown = undefined;
  let weights: unknown = undefined;

  for (const p of chain) {
    // overrides first, so newSpecies introduced by this pack can be referenced by its legal list
    overrides = {
      species: mergeRecord(overrides.species, p.overrides.species),
      newSpecies: mergeRecord(overrides.newSpecies, p.overrides.newSpecies),
      moves: mergeRecord(overrides.moves, p.overrides.moves),
      abilities: mergeRecord(overrides.abilities, p.overrides.abilities),
      items: mergeRecord(overrides.items, p.overrides.items),
    };
    const dex = dexWithNewSpecies(base, overrides.newSpecies);
    checkOverrides(p, base, dex, issues);

    const exists: Record<LegalSetKey, [(id: string) => boolean, string]> = {
      species: [(x) => dex.species(x) !== undefined, "species"],
      megaSpecies: [(x) => dex.species(x) !== undefined, "species"],
      items: [(x) => dex.hasItem(x), "item"],
      bannedMoves: [(x) => dex.hasMove(x), "move"],
      bannedAbilities: [(x) => dex.hasAbility(x), "ability"],
    };
    const next = {} as Record<LegalSetKey, string[]>;
    for (const k of LEGAL_SETS) {
      checkDelta(p.id, "legal", k, p.legal[k], legal?.[k], exists[k][0], exists[k][1], issues);
      next[k] = applySetDelta(legal?.[k], p.legal[k]);
    }
    legal = next;
    checkDelta(
      p.id,
      "manifest",
      "mechanics",
      p.manifest.mechanics,
      mechanics,
      () => true,
      "mechanic",
      issues,
    );
    mechanics = applySetDelta(mechanics, p.manifest.mechanics);
    rules = deepMerge(rules, stripSchema(p.rules));
    weights = deepMerge(weights, stripSchema(p.weights));
  }

  const leaf = chain.at(-1)!;
  const rulesR = RulesSchema.safeParse(rules);
  if (!rulesR.success) issues.push(...zodIssues(leaf.id, "rules", rulesR.error));
  const weightsR = WeightsSchema.safeParse(weights);
  if (!weightsR.success) issues.push(...zodIssues(leaf.id, "weights", weightsR.error));
  if (issues.length > 0 || !legal || !mechanics || !rulesR.success || !weightsR.success) {
    throw new PackValidationError(id, issues);
  }

  const dex = dexWithNewSpecies(base, overrides.newSpecies);
  checkResolved(leaf.id, legal, mechanics, rulesR.data, dex, options, issues);
  if (issues.length > 0) throw new PackValidationError(id, issues);

  const content = {
    chain: chain.map((p) => p.id),
    legal,
    mechanics,
    overrides,
    rules: rulesR.data,
    weights: weightsR.data,
  };
  const resolved: ResolvedPack = {
    id: leaf.id,
    name: leaf.manifest.name,
    chain: content.chain,
    dataVersion: leaf.manifest.dataVersion,
    contentHash: sha256Hex(canonicalJson(content)).slice(0, 16),
    verified: chain.every((p) => p.manifest.verified && p.legal.verified),
    periods: leaf.manifest.periods,
    mechanics,
    sources: leaf.manifest.sources,
    legal: { verified: chain.every((p) => p.legal.verified), ...legal },
    overrides,
    rules: rulesR.data,
    weights: weightsR.data,
  };
  return ResolvedPackSchema.parse(resolved);
}

function stripSchema(v: unknown): unknown {
  if (typeof v !== "object" || v === null) return v;
  const { $schema, ...rest } = v as Record<string, unknown>;
  return rest;
}

function checkOverrides(p: ParsedPack, base: Dex, dex: Dex, issues: PackIssue[]): void {
  const o = p.overrides;
  const push = (path: string, message: string) =>
    issues.push({ packId: p.id, file: "overrides", path, message });
  for (const [id, v] of Object.entries(o.species)) {
    if (!dex.species(id)) push(`species.${id}`, `unknown species "${id}"`);
    v?.abilities?.forEach((a, i) => {
      if (!dex.hasAbility(a)) push(`species.${id}.abilities.${i}`, `unknown ability "${a}"`);
    });
  }
  for (const [id, v] of Object.entries(o.newSpecies)) {
    if (v === null) continue;
    if (base.species(id))
      push(
        `newSpecies.${id}`,
        `"${id}" already exists in the base dex; use "species" overrides instead`,
      );
    if (v.baseSpecies !== undefined && !dex.species(v.baseSpecies))
      push(`newSpecies.${id}.baseSpecies`, `unknown species "${v.baseSpecies}"`);
    v.abilities.forEach((a, i) => {
      if (!dex.hasAbility(a)) push(`newSpecies.${id}.abilities.${i}`, `unknown ability "${a}"`);
    });
  }
  for (const id of Object.keys(o.moves))
    if (!dex.hasMove(id)) push(`moves.${id}`, `unknown move "${id}"`);
  for (const id of Object.keys(o.abilities))
    if (!dex.hasAbility(id)) push(`abilities.${id}`, `unknown ability "${id}"`);
  for (const id of Object.keys(o.items))
    if (!dex.hasItem(id)) push(`items.${id}`, `unknown item "${id}"`);
}

function checkResolved(
  packId: string,
  legal: Record<LegalSetKey, string[]>,
  mechanics: string[],
  rules: z.infer<typeof RulesSchema>,
  dex: Dex,
  options: LoadOptions,
  issues: PackIssue[],
): void {
  const push = (file: PackIssue["file"], path: string, message: string) =>
    issues.push({ packId, file, path, message });
  const species = new Set(legal.species);
  const items = new Set(legal.items);
  for (const id of legal.species) {
    if (dex.species(id)?.isMega)
      push(
        "legal",
        "species",
        `"${id}" is a Mega forme; list the base species in "species" and "megaSpecies"`,
      );
  }
  const stones = [...dex.megaStones()];
  for (const id of legal.megaSpecies) {
    if (!species.has(id))
      push("legal", "megaSpecies", `"${id}" can Mega Evolve but is not in the legal species list`);
    const usable = stones.filter(([item, s]) => s.baseId === id && items.has(item));
    if (usable.length === 0)
      push("legal", "megaSpecies", `"${id}" has no legal Mega Stone in the items list`);
  }
  if (legal.megaSpecies.length > 0 && !mechanics.includes("mega")) {
    push(
      "manifest",
      "mechanics",
      `megaSpecies is non-empty but the "mega" mechanic is not enabled`,
    );
  }
  if (options.knownMechanics) {
    for (const m of mechanics)
      if (!options.knownMechanics.includes(m))
        push("manifest", "mechanics", `unknown mechanic plugin "${m}"`);
  }
  if (rules.bringCount > rules.teamSize)
    push("rules", "bringCount", "bringCount must be <= teamSize");
  if (rules.activeCount > rules.bringCount)
    push("rules", "activeCount", "activeCount must be <= bringCount");
}

export interface PackLoadReport {
  id: string;
  pack?: ResolvedPack;
  error?: PackValidationError;
}

/** Load every pack in the source, collecting errors instead of throwing. */
export function loadAllPacks(source: PackSource, options: LoadOptions = {}): PackLoadReport[] {
  return source.listPackIds().map((id) => {
    try {
      return { id, pack: loadPack(source, id, options) };
    } catch (e) {
      if (e instanceof PackValidationError) return { id, error: e };
      throw e;
    }
  });
}
