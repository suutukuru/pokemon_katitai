import {
  EngineTagsSchema,
  UsageSnapshotSchema,
  type EngineTags,
  type UsageSnapshot,
} from "@ca/schema";
import raw from "../engine/tags.json" with { type: "json" };

let cached: EngineTags | undefined;
/** Move/ability classifications for the rule engine. */
export function engineTags(): EngineTags {
  return (cached ??= EngineTagsSchema.parse(raw));
}

export function parseUsageSnapshot(json: unknown): UsageSnapshot {
  return UsageSnapshotSchema.parse(json);
}
