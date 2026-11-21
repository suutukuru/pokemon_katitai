import { PACK_FILES, type PackFile, type PackSource } from "../src/index.js";
import { FsPackSource } from "../src/node.js";

type Files = Partial<Record<PackFile, unknown>>;

/** In-memory copy of the real packs, which tests can modify freely. */
export class TestSource implements PackSource {
  packs: Record<string, Files>;
  constructor(packs?: Record<string, Files>) {
    this.packs = packs ?? realPacks();
  }
  listPackIds(): string[] {
    return Object.keys(this.packs).sort();
  }
  read(packId: string, file: PackFile): unknown {
    const v = this.packs[packId]?.[file];
    return v === undefined ? undefined : structuredClone(v);
  }
  write(packId: string, files: Record<string, unknown>): string {
    this.packs[packId] = structuredClone(files) as Files;
    return `memory:${packId}`;
  }
  /** Deep-clone the pack and apply a mutation to the given file. */
  edit(packId: string, file: PackFile, fn: (json: Record<string, unknown>) => void): this {
    const pack = (this.packs[packId] ??= {});
    const json = structuredClone((pack[file] ?? {}) as Record<string, unknown>);
    fn(json);
    pack[file] = json;
    return this;
  }
}

export function realPacks(): Record<string, Files> {
  const fs = new FsPackSource();
  return Object.fromEntries(
    fs
      .listPackIds()
      .map((id) => [
        id,
        Object.fromEntries(
          PACK_FILES.map((f) => [f, fs.read(id, f)]).filter(([, v]) => v !== undefined),
        ),
      ]),
  );
}

/** A small child pack of M-B. */
export function childOf(parent: string, id: string, files: Files = {}): Files {
  return {
    manifest: { id, name: { ja: id, en: id }, extends: parent, dataVersion: "t", verified: false },
    ...files,
  };
}
