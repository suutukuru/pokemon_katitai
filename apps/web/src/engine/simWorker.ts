// Simulation worker: runs rollouts and whole battles (pokemon-showdown, bundled for the browser).
import { inProcessExecutor, rollout, rolloutContext } from "@ca/sim";
import { contextFor } from "./context";
import type { SimReply, SimRequest } from "./protocol";

const post = (m: SimReply) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<SimRequest>) => {
  const req = ev.data;
  try {
    const ctx = contextFor(req.regulationId);
    if (req.kind === "rollouts") {
      const rc = rolloutContext(ctx);
      const { state, items } = req.batch;
      post({ id: req.id, ok: true, results: items.map((it) => rollout(rc, state, it)) });
      return;
    }
    const exec = inProcessExecutor(ctx, req.mine, req.theirs);
    const results =
      req.kind === "battles" ? await exec.run(req.jobs) : await exec.bestPlay!(req.jobs);
    post({ id: req.id, ok: true, results });
  } catch (e) {
    post({ id: req.id, ok: false, message: e instanceof Error ? e.message : String(e) });
  }
};
