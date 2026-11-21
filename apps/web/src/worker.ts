// Diagnosis runs here so the UI stays responsive (PLAN §7 performance).
import { gameSpec, displayName, loadPack, parseUsageSnapshot } from "@ca/data";
import type { UsageSnapshot } from "@ca/schema";
import { diagnose, MECHANIC_IDS } from "@ca/engine";
import { explainFinding } from "@ca/explain";
import { parseShowdown } from "@ca/ingest";
import { packSource } from "./bundled";
import type { DiagnoseRequest, DiagnoseResponse, ErrorResponse, MemberView } from "./protocol";

const post = (msg: DiagnoseResponse | ErrorResponse) =>
  (self as unknown as Worker).postMessage(msg);

const regulations = packSource
  .listPackIds()
  .filter((id) => !id.includes("DUMMY"))
  .map((id) => ({ id, name: loadPack(packSource, id).name.ja }));

// Usage snapshots are loaded lazily: only the newest, highest-cutoff file for the regulation.
const usageFiles = import.meta.glob("../../../packages/data/usage/*/*.json", { import: "default" });
const usageCache = new Map<string, Promise<UsageSnapshot | undefined>>();
function usageFor(regulationId: string): Promise<UsageSnapshot | undefined> {
  let p = usageCache.get(regulationId);
  if (!p) {
    const key = Object.keys(usageFiles)
      .filter((k) => k.includes(`/usage/${regulationId}/`))
      .sort((a, b) => {
        const m = (k: string) => /(\d{4}-\d{2})-\w+-(\d+)\.json$/.exec(k) ?? ["", "", "0"];
        return m(b)[1]!.localeCompare(m(a)[1]!) || Number(m(b)[2]) - Number(m(a)[2]);
      })[0];
    p = key ? usageFiles[key]!().then((j) => parseUsageSnapshot(j)) : Promise.resolve(undefined);
    usageCache.set(regulationId, p);
  }
  return p;
}

self.onmessage = async (ev: MessageEvent<DiagnoseRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  try {
    const pack = loadPack(packSource, req.regulationId, { knownMechanics: MECHANIC_IDS });
    const spec = gameSpec();
    const parsed = parseShowdown(req.text, {
      legal: { species: pack.legal.species, items: pack.legal.items },
    });
    const usage = await usageFor(req.regulationId);
    const report = parsed.members.length
      ? diagnose(parsed.members, pack, spec, usage ? { usage } : {})
      : null;
    const members: MemberView[] = parsed.members.map((m, i) => {
      const view = report?.members[i];
      return {
        species: m.species,
        name: displayName("species", m.species),
        formeName: displayName("species", view?.forme ?? m.species),
        mega: view?.mega ?? false,
        item: m.item ? displayName("items", m.item) : "なし",
        ability: displayName("abilities", m.ability),
        nature: displayName("natures", m.nature.toLowerCase()),
        moves: m.moves.map((x) => displayName("moves", x)),
        stats: view?.stats ?? {},
        sp: m.sp,
        assumed: m.assumed,
        lowConfidence: Object.entries(m.confidence)
          .filter(([, c]) => c < 1)
          .map(([k]) => k),
      };
    });
    const explained = (report?.findings ?? []).map((f) => ({
      ruleId: f.ruleId,
      ...explainFinding(f),
    }));
    const { members: _omit, ...rest } = report ?? { members: [] };
    post({
      type: "result",
      id: req.id,
      issues: parsed.issues,
      members,
      report: report ? (rest as DiagnoseResponse["report"]) : null,
      explained,
      regulations,
      ms: Math.round(performance.now() - t0),
    });
  } catch (e) {
    post({ type: "error", id: req.id, message: e instanceof Error ? e.message : String(e) });
  }
};
