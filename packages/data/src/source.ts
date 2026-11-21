export const PACK_FILES = ["manifest", "legal", "overrides", "rules", "weights"] as const;
export type PackFile = (typeof PACK_FILES)[number];

/**
 * Where pack JSON comes from. Platform-neutral so the same loader runs in Node (fs),
 * the browser (bundled JSON) and Workers.
 */
export interface PackSource {
  listPackIds(): string[];
  /** Parsed JSON, or `undefined` if the file does not exist (all files except manifest are optional). */
  read(packId: string, file: PackFile): unknown;
}

export class MemoryPackSource implements PackSource {
  constructor(private readonly packs: Record<string, Partial<Record<PackFile, unknown>>>) {}
  listPackIds(): string[] {
    return Object.keys(this.packs).sort();
  }
  read(packId: string, file: PackFile): unknown {
    return this.packs[packId]?.[file];
  }
}
