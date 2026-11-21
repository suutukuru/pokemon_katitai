/** Two-player zero-sum matrix game utilities (row player maximizes). */

export interface GameSolution {
  row: number[];
  col: number[];
  /** Expected payoff for the row player at the (approximate) equilibrium. */
  value: number;
}

/** Fictitious play: deterministic, converges for zero-sum games. Payoffs in [0,1]. */
export function solveZeroSum(m: number[][], iterations: number): GameSolution {
  const R = m.length;
  const C = m[0]?.length ?? 0;
  if (R === 0 || C === 0) return { row: [], col: [], value: 0 };
  const rowCount = new Array<number>(R).fill(0);
  const colCount = new Array<number>(C).fill(0);
  const rowPay = new Array<number>(R).fill(0); // vs column history
  const colPay = new Array<number>(C).fill(0); // row payoff vs row history (col minimizes)
  let r = 0;
  let c = 0;
  for (let it = 0; it < iterations; it++) {
    rowCount[r]!++;
    colCount[c]!++;
    for (let i = 0; i < R; i++) rowPay[i]! += m[i]![c]!;
    for (let j = 0; j < C; j++) colPay[j]! += m[r]![j]!;
    r = argBest(rowPay, (a, b) => a > b);
    c = argBest(colPay, (a, b) => a < b);
  }
  const row = rowCount.map((x) => x / iterations);
  const col = colCount.map((x) => x / iterations);
  let value = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) value += row[i]! * col[j]! * m[i]![j]!;
  return { row, col, value };
}

function argBest(xs: number[], better: (a: number, b: number) => boolean): number {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (better(xs[i]!, xs[best]!)) best = i;
  return best;
}

/** Row maximin (pure): the row whose worst column is best. */
export function maximin(m: number[][]): { row: number; value: number } {
  let row = 0;
  let value = -Infinity;
  m.forEach((r, i) => {
    const worst = Math.min(...r);
    if (worst > value) {
      value = worst;
      row = i;
    }
  });
  return { row, value };
}

/** Wilson score interval (95%) for a win rate. */
export function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
