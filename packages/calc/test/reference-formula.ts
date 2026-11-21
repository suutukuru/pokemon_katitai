/**
 * Independent implementation of the published Gen 5+ damage formula, used only to
 * check the @smogon/calc adapter on simple cases (no item/ability modifiers).
 * Order: base → spread → weather → crit → random → STAB → type.
 */
export interface RefCase {
  bp: number;
  A: number;
  D: number;
  level?: number;
  stab: boolean;
  eff: number;
  spread?: boolean;
  weatherMod?: number;
  crit?: boolean;
}

/** Game Freak's 4096-based modifier with round-half-down. */
function modify(value: number, mod: number): number {
  const m = Math.round(mod * 4096);
  return Math.floor((value * m + 2047) / 4096);
}

export function referenceRolls(c: RefCase): number[] {
  const L = c.level ?? 50;
  const base = Math.floor(Math.floor((Math.floor((2 * L) / 5 + 2) * c.bp * c.A) / c.D) / 50) + 2;
  const rolls: number[] = [];
  for (let r = 85; r <= 100; r++) {
    let d = base;
    if (c.spread) d = modify(d, 0.75);
    if (c.weatherMod !== undefined) d = modify(d, c.weatherMod);
    if (c.crit) d = Math.floor(d * 1.5);
    d = Math.floor((d * r) / 100);
    if (c.stab) d = modify(d, 1.5);
    d = Math.floor(d * c.eff);
    rolls.push(Math.max(1, d));
  }
  return rolls;
}
