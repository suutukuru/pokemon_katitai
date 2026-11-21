// Diagnosis runs here so the UI stays responsive (PLAN §7 performance).
import { gameSpec, displayName, loadPack } from "@ca/data";
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

self.onmessage = (ev: MessageEvent<DiagnoseRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  try {
    const pack = loadPack(packSource, req.regulationId, { knownMechanics: MECHANIC_IDS });
    const spec = gameSpec();
    const parsed = parseShowdown(req.text, {
      legal: { species: pack.legal.species, items: pack.legal.items },
    });
    const report = parsed.members.length ? diagnose(parsed.members, pack, spec) : null;
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
