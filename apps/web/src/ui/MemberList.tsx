import { useEffect, useState } from "react";
import { diagnoseText } from "../diagnoseClient";
import type { MemberView } from "../protocol";

const STAT_LABEL: Record<string, string> = {
  hp: "H",
  atk: "A",
  def: "B",
  spa: "C",
  spd: "D",
  spe: "S",
};

/** Members of a team with real stats (computed in the diagnosis worker). */
export function MemberList({
  text,
  regulationId,
  estimated,
  highlight,
}: {
  text: string;
  regulationId: string;
  estimated?: boolean;
  /** species IDs to mark (e.g. the recommended bring) */
  highlight?: string[];
}) {
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMembers(null);
    diagnoseText(text, regulationId).then(
      (r) => live && (setMembers(r.members), setError(null)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [text, regulationId]);
  if (error) return <p className="error">読み取りエラー: {error}</p>;
  if (!members) return <p className="muted">読み込み中…</p>;
  return (
    <ul className="members">
      {members.map((m, k) => (
        <li key={k} className={`member ${highlight?.includes(m.species) ? "picked" : ""}`}>
          <div className="member-head">
            <strong>{m.formeName}</strong>
            {m.mega && <span className="tag">メガ後</span>}
            {highlight?.includes(m.species) && <span className="tag pick">選出</span>}
          </div>
          <div className="muted small">
            {m.item} / {m.ability} / {m.nature}
          </div>
          <div className="stats">
            {Object.entries(m.stats).map(([s, v]) => (
              <span key={s} className="stat">
                <abbr title={s}>{STAT_LABEL[s]}</abbr>
                {v}
                <small>{m.sp[s] ? `(${m.sp[s]})` : ""}</small>
              </span>
            ))}
          </div>
          <div className="moves">
            {m.moves.map((x, i) => (
              <span key={i} className="move-chip">
                {x}
              </span>
            ))}
          </div>
          {(estimated || m.assumed.length > 0) && (
            <div className="estimated-note">
              〜 推測を含む
              {m.assumed.length
                ? `: ${m.assumed.join("、")}（仮の値）`
                : "（使用率から推定した型）"}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
