// Regulation packs and sample teams bundled into the app at build time (no network needed).
import { MemoryPackSource, type PackFile } from "@ca/data";

const packFiles = import.meta.glob("../../../packages/data/regulations/*/*.json", {
  eager: true,
  import: "default",
});
const packs: Record<string, Partial<Record<PackFile, unknown>>> = {};
for (const [path, json] of Object.entries(packFiles)) {
  const m = /regulations\/([^/]+)\/(\w+)\.json$/.exec(path);
  if (m) (packs[m[1]!] ??= {})[m[2] as PackFile] = json;
}
export const packSource = new MemoryPackSource(packs);
