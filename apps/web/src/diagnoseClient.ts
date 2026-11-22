// One shared diagnosis worker for every tab (team views, diagnosis).
import type { DiagnoseResponse, ErrorResponse } from "./protocol";

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, (r: DiagnoseResponse | ErrorResponse) => void>();

function get(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<DiagnoseResponse | ErrorResponse>) => {
      waiting.get(ev.data.id)?.(ev.data);
      waiting.delete(ev.data.id);
    };
  }
  return worker;
}

export function diagnoseText(text: string, regulationId: string): Promise<DiagnoseResponse> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) => (r.type === "error" ? reject(new Error(r.message)) : resolve(r)));
    get().postMessage({ type: "diagnose", id, text, regulationId });
  });
}
