import {
  EngineTagsSchema,
  UsageSnapshotSchema,
  type EngineTags,
  type UsageSnapshot,
} from "@ca/schema";
import raw from "../engine/tags.json" with { type: "json" };
import rawArchetypes from "../engine/archetypes.json" with { type: "json" };
import { ArchetypesSchema, type Archetypes } from "@ca/schema";

let cached: EngineTags | undefined;
/** Move/ability classifications for the rule engine. */
export function engineTags(): EngineTags {
  return (cached ??= EngineTagsSchema.parse(raw));
}

export function parseUsageSnapshot(json: unknown): UsageSnapshot {
  return UsageSnapshotSchema.parse(json);
}

let cachedArch: Archetypes | undefined;
/** Archetype classification rules (data). */
export function archetypeRules(): Archetypes {
  return (cachedArch ??= ArchetypesSchema.parse(rawArchetypes));
}
