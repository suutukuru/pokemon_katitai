import {
  diffPacks,
  formatDiff,
  loadAllPacks,
  loadPack,
  scaffoldPack,
  type PackSource,
} from "@ca/data";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface WritablePackSource extends PackSource {
  write(packId: string, files: Record<string, unknown>): string;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const v = inline ?? args[i + 1];
      if (v === undefined || (inline === undefined && v.startsWith("--")))
        throw new Error(`--${k} requires a value`);
      flags[k] = v;
      if (inline === undefined) i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

/** `reg:new <id> [--extends <parent>] [--name-ja ..] [--name-en ..]` */
export function regNew(args: string[], source: WritablePackSource, io: Io, today: string): number {
  const { positional, flags } = parseFlags(args);
  const id = positional[0];
  if (!id) {
    io.err("usage: pnpm reg:new <id> --extends <parent>");
    return 2;
  }
  if (source.listPackIds().includes(id)) {
    io.err(`pack "${id}" already exists`);
    return 1;
  }
  const parent = flags["extends"];
  if (parent !== undefined) loadPack(source, parent); // parent must be valid
  const files = scaffoldPack({
    id,
    today,
    ...(parent !== undefined ? { extends: parent } : {}),
    ...(flags["name-ja"] !== undefined ? { nameJa: flags["name-ja"] } : {}),
    ...(flags["name-en"] !== undefined ? { nameEn: flags["name-en"] } : {}),
  });
  const dir = source.write(id, files);
  loadPack(source, id); // the scaffold itself must validate
  io.out(`created ${dir}`);
  io.out(
    "次の手順: legal.json / overrides.json に差分を書き、pnpm reg:validate と pnpm reg:diff で確認する",
  );
  return 0;
}

/** `reg:diff <a> <b> [--json]` */
export function regDiff(args: string[], source: PackSource, io: Io): number {
  const { positional, flags } = parseFlags(args.filter((a) => a !== "--json"));
  void flags;
  const [a, b] = positional;
  if (!a || !b) {
    io.err("usage: pnpm reg:diff <a> <b> [--json]");
    return 2;
  }
  const d = diffPacks(loadPack(source, a), loadPack(source, b));
  io.out(args.includes("--json") ? JSON.stringify(d, null, 2) : formatDiff(d));
  return 0;
}

/** `reg:validate [id...]` — validate the named packs, or all of them. */
export function regValidate(args: string[], source: PackSource, io: Io): number {
  const reports = loadAllPacks(source).filter((r) => args.length === 0 || args.includes(r.id));
  const missing = args.filter((a) => !reports.some((r) => r.id === a));
  for (const m of missing) io.err(`✗ ${m}: pack does not exist`);
  for (const r of reports) {
    if (r.pack)
      io.out(
        `✓ ${r.id} (chain ${r.pack.chain.join(" → ")}, data ${r.pack.dataVersion}, hash ${r.pack.contentHash}${r.pack.verified ? "" : ", 未検証"})`,
      );
    else io.err(`✗ ${r.error!.message}`);
  }
  return missing.length > 0 || reports.some((r) => r.error) ? 1 : 0;
}
