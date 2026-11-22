import { pct, sp } from "./format";

/** Win-rate bar: the number is the label, the bar is only a visual aid. */
export function RateBar({ value, label }: { value: number; label?: string }) {
  const tone = value >= 0.6 ? "good" : value <= 0.4 ? "bad" : "mid";
  return (
    <span className={`ratebar ${tone}`} aria-label={`${label ?? "勝率"} ${pct(value)}`}>
      <span className="fill" style={{ width: `${Math.round(value * 100)}%` }} />
      <span className="num">{pct(value)}</span>
    </span>
  );
}

export function BringNames({ species }: { species: string[] }) {
  return (
    <span className="bring">
      <span className="lead">{species.slice(0, 2).map(sp).join("・")}</span>
      <span className="muted"> ／ 後ろ {species.slice(2).map(sp).join("・")}</span>
    </span>
  );
}

/** Evaluation history as a small line chart (my win rate per decision). */
export function EvalSpark({ values, height = 44 }: { values: number[]; height?: number }) {
  if (values.length === 0) return null;
  const w = 300;
  const pts = values.map((v, i) => [
    values.length === 1 ? w / 2 : (i / (values.length - 1)) * w,
    (1 - v) * (height - 6) + 3,
  ]);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} role="img" aria-label="評価値の推移">
      <line x1="0" x2={w} y1={height / 2} y2={height / 2} className="mid" />
      <polyline points={pts.map((p) => p.join(",")).join(" ")} className="line" />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === pts.length - 1 ? 3.5 : 2} className="dot" />
      ))}
    </svg>
  );
}
