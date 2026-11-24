// Reflection (ADR-0012): after a decision's result is known, compare what the planner expected
// with what was actually achievable, and summarise many decisions into numbers that show where
// the engine misjudges (calibration, regret, surprises).
import { restore, type Snapshot } from "./replay.js";
import type { SimContext } from "./runner.js";
import { columnOf, type OptionSlot, type PositionAnalysis } from "./search.js";

export interface DecisionReview {
  side: 0 | 1;
  turn: number;
  /** the action taken */
  chosen: string;
  /** readable slots of the chosen / best action and of the opponent's actual action */
  labels?: { chosen?: OptionSlot[]; best?: OptionSlot[]; opponent?: OptionSlot[] };
  /** this side's expected win rate for the chosen action (vs the predicted opponent mix) */
  expected: number;
  /** whether the opponent had a decision at the same time */
  opponentActed: boolean;
  /** the opponent's actual action, as the planner's column (-1 = not among its candidates) */
  actualColumn: number;
  /** probability the planner gave the opponent's actual action */
  predictedProb: number;
  /** win rate of the chosen action against what the opponent actually did */
  vsActual?: number;
  /** best win rate available against what the opponent actually did, and that action */
  bestVsActual?: number;
  bestChoice?: string;
  /** bestVsActual − vsActual (≥ 0): what knowing the opponent's move would have been worth */
  regret?: number;
  /** final result from this side's view (1 win, 0 loss, ½ draw), filled in after the game */
  outcome?: number;
}

/** Review one decision of side `s` with the planner's analysis and both sides' actual choices. */
export function reviewDecision(
  ctx: SimContext,
  state: Snapshot,
  an: PositionAnalysis,
  s: 0 | 1,
  chosen: string,
  opponentChoice: string,
): DecisionReview {
  const o = (1 - s) as 0 | 1;
  const mine = an.options[s].find((x) => x.choice === chosen);
  const base: DecisionReview = {
    side: s,
    turn: an.turn,
    chosen,
    expected: mine?.value ?? an.value,
    opponentActed: an.needs[o] && !!opponentChoice,
    actualColumn: -1,
    predictedProb: 0,
  };
  if (!an.needs[o] || !opponentChoice) return base;
  const j = columnOf(ctx, an, restore(state), o as 0 | 1, opponentChoice);
  if (j < 0) return base;
  const opp = an.options[o].find((x) => x.choice === an.matrixChoices[o][j]);
  // matrix rows are p1's options, columns p2's, values are p1's win rate
  const valueFor = (myIdx: number) => {
    const v = s === 0 ? an.matrix[myIdx]![j]! : an.matrix[j]![myIdx]!;
    return s === 0 ? v : 1 - v;
  };
  const myList = an.matrixChoices[s];
  const i = myList.indexOf(chosen);
  let best = 0;
  myList.forEach((_, k) => {
    if (valueFor(k) > valueFor(best)) best = k;
  });
  const lab = (side: 0 | 1, c: string | undefined) =>
    c ? an.options[side].find((x) => x.choice === c)?.slots : undefined;
  return {
    ...base,
    labels: {
      ...(lab(s, chosen) ? { chosen: lab(s, chosen)! } : {}),
      ...(lab(s, myList[best]) ? { best: lab(s, myList[best])! } : {}),
      ...(opp ? { opponent: opp.slots } : {}),
    },
    actualColumn: j,
    predictedProb: opp?.prob ?? 0,
    ...(i >= 0 ? { vsActual: valueFor(i) } : {}),
    bestVsActual: valueFor(best),
    bestChoice: myList[best]!,
    ...(i >= 0 ? { regret: Math.max(0, valueFor(best) - valueFor(i)) } : {}),
  };
}

export interface ReviewSummary {
  decisions: number;
  /** mean squared error of `expected` against the final outcome (lower is better; 0.25 = coin flip) */
  brier: number;
  /** mean regret where the opponent's action was among the candidates */
  meanRegret: number;
  /** share of decisions where the chosen action was already the best reply to what happened */
  bestReplyRate: number;
  /** share of decisions where the opponent did something outside the planner's candidates */
  surpriseRate: number;
  /** mean probability the planner gave to the opponent's actual action */
  meanPredictedProb: number;
  /** expected vs observed win rate per bucket of `expected` */
  calibration: { from: number; to: number; n: number; expected: number; observed: number }[];
}

export function summarizeReviews(rs: DecisionReview[], buckets = 5): ReviewSummary {
  const done = rs.filter((r) => r.outcome !== undefined);
  const withCol = rs.filter((r) => r.actualColumn >= 0);
  const withRegret = withCol.filter((r) => r.regret !== undefined);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  const calibration = Array.from({ length: buckets }, (_, b) => {
    const from = b / buckets;
    const to = (b + 1) / buckets;
    const xs = done.filter(
      (r) => r.expected >= from && (r.expected < to || (b === buckets - 1 && r.expected <= 1)),
    );
    return {
      from,
      to,
      n: xs.length,
      expected: mean(xs.map((r) => r.expected)),
      observed: mean(xs.map((r) => r.outcome!)),
    };
  });
  return {
    decisions: rs.length,
    brier: mean(done.map((r) => (r.expected - r.outcome!) ** 2)),
    meanRegret: mean(withRegret.map((r) => r.regret!)),
    bestReplyRate: mean(withRegret.map((r) => (r.regret! <= 1e-9 ? 1 : 0))),
    surpriseRate: mean(rs.filter((r) => r.opponentActed).map((r) => (r.actualColumn < 0 ? 1 : 0))),
    meanPredictedProb: mean(withCol.map((r) => r.predictedProb)),
    calibration,
  };
}

const logit = (p: number) => {
  const q = Math.min(1 - 1e-4, Math.max(1e-4, p));
  return Math.log(q / (1 - q));
};
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * Fit p' = σ(a·logit(p) + b) to (expected, outcome) pairs by Newton's method (logistic
 * regression on one feature). a = 1, b = 0 is the identity.
 */
export function fitCalibration(rs: DecisionReview[]): { a: number; b: number; n: number } {
  const xs = rs
    .filter((r) => r.outcome !== undefined)
    .map((r) => [logit(r.expected), r.outcome!] as const);
  let a = 1;
  let b = 0;
  for (let it = 0; it < 50; it++) {
    let ga = 0;
    let gb = 0;
    let haa = 1e-6;
    let hab = 0;
    let hbb = 1e-6;
    for (const [x, y] of xs) {
      const p = sigmoid(a * x + b);
      const w = p * (1 - p);
      ga += (y - p) * x;
      gb += y - p;
      haa += w * x * x;
      hab += w * x;
      hbb += w;
    }
    // small ridge toward the identity keeps the fit sane with little data
    ga -= 0.5 * (a - 1);
    gb -= 0.5 * b;
    haa += 0.5;
    hbb += 0.5;
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }
  return { a, b, n: xs.length };
}

/** Calibrated win rate for display (weights.json `evalCalibA` / `evalCalibB`; identity if unset). */
export function calibrated(p: number, params: Record<string, number>): number {
  const a = params["evalCalibA"];
  const b = params["evalCalibB"];
  if (a === undefined || b === undefined) return p;
  return sigmoid(a * logit(p) + b);
}
