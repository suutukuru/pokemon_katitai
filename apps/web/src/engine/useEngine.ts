import { useEffect, useState } from "react";
import { SimPool } from "./pool";

import type * as SessionModule from "./session";

export type Session = typeof SessionModule;

let sessionP: Promise<Session> | null = null;
const pools = new Map<string, SimPool>();

/** Load the simulator (Showdown) on demand. */
export function loadSession(): Promise<Session> {
  return (sessionP ??= import("./session"));
}

/** One worker pool per regulation, shared by every tab. */
export function poolFor(regulationId: string): SimPool {
  let p = pools.get(regulationId);
  if (!p) {
    p = new SimPool(regulationId);
    pools.set(regulationId, p);
  }
  return p;
}

export function useSession(): Session | null {
  const [s, setS] = useState<Session | null>(null);
  useEffect(() => {
    let live = true;
    loadSession().then((x) => live && setS(x));
    return () => {
      live = false;
    };
  }, []);
  return s;
}
