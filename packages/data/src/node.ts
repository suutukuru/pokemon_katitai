// Node-only entry point (`@ca/data/node`). Do not import from browser/Workers code.
import type { TeamDatabaseFile, UsageSnapshot } from "@ca/schema";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PackFile, PackSource } from "./source.js";
import { parseTeamDbFile } from "./teamdb.js";
import { parseUsageSnapshot } from "./engine-data.js";

export const DEFAULT_REGULATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../regulations",
);

export class FsPackSource implements PackSource {
  constructor(readonly root: string = DEFAULT_REGULATIONS_DIR) {}
  listPackIds(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((d) => statSync(join(this.root, d)).isDirectory())
      .sort();
  }
  read(packId: string, file: PackFile): unknown {
    const p = join(this.root, packId, `${file}.json`);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, "utf8"));
  }
  write(packId: string, files: Partial<Record<PackFile, unknown>>): string {
    const dir = join(this.root, packId);
    if (existsSync(dir)) throw new Error(`pack directory already exists: ${dir}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(content, null, 2) + "\n");
    }
    return dir;
  }
}

export const DEFAULT_TEAMS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../teams");

/** All team database files under packages/data/teams/<dataset>/*.json (excluding samples). */
export function readTeamDbFiles(root: string = DEFAULT_TEAMS_DIR): TeamDatabaseFile[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => d !== "samples" && statSync(join(root, d)).isDirectory())
    .flatMap((d) =>
      readdirSync(join(root, d))
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => parseTeamDbFile(JSON.parse(readFileSync(join(root, d, f), "utf8")))),
    );
}

export const DEFAULT_USAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../usage");

/** Usage snapshots for a regulation, newest first; within a month, the highest rating cutoff first. */
export function readUsageSnapshots(
  regulationId: string,
  root: string = DEFAULT_USAGE_DIR,
): UsageSnapshot[] {
  const dir = join(root, regulationId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseUsageSnapshot(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.cutoff ?? 0) - (a.cutoff ?? 0));
}
