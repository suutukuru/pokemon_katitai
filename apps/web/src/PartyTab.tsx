import { useState } from "react";
import { saveAll, type SavedTeam } from "./storage";
import type { TeamEntry } from "./teams";
import { MemberList } from "./ui/MemberList";
import { TeamPicker } from "./ui/TeamPicker";

export function PartyTab({
  teams,
  regulationId,
  mineId,
  setMineId,
  oppId,
  setOppId,
  saved,
  setSaved,
}: {
  teams: TeamEntry[];
  regulationId: string;
  mineId: string;
  setMineId: (id: string) => void;
  oppId: string;
  setOppId: (id: string) => void;
  saved: SavedTeam[];
  setSaved: (s: SavedTeam[]) => void;
}) {
  const [which, setWhich] = useState<"mine" | "opp">("mine");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const id = which === "mine" ? mineId : oppId;
  const team = teams.find((t) => t.id === id);

  const startEdit = (text: string) => {
    setEditing(text);
    setName(team ? `${team.name}（改）` : "新しいパーティ");
  };
  const save = () => {
    if (editing === null) return;
    const entry: SavedTeam = {
      id: `t${Date.now()}`,
      name: name.trim() || "新しいパーティ",
      text: editing,
      regulationId,
      savedAt: new Date().toISOString(),
    };
    const next = [entry, ...saved];
    setSaved(next);
    saveAll(next);
    (which === "mine" ? setMineId : setOppId)(`saved:${entry.id}`);
    setEditing(null);
  };
  const remove = () => {
    if (!team || team.group !== "saved") return;
    const next = saved.filter((t) => `saved:${t.id}` !== team.id);
    setSaved(next);
    saveAll(next);
    (which === "mine" ? setMineId : setOppId)(teams.find((t) => t.group === "mine")?.id ?? "");
  };

  return (
    <div className="tab-body">
      <div className="seg" role="tablist" aria-label="表示するパーティ">
        <button
          role="tab"
          aria-selected={which === "mine"}
          className={which === "mine" ? "on" : ""}
          onClick={() => setWhich("mine")}
        >
          自分
        </button>
        <button
          role="tab"
          aria-selected={which === "opp"}
          className={which === "opp" ? "on" : ""}
          onClick={() => setWhich("opp")}
        >
          相手
        </button>
      </div>
      <section className="card">
        <TeamPicker
          label={which === "mine" ? "自分のパーティ" : "相手のパーティ"}
          teams={teams}
          value={id}
          onChange={which === "mine" ? setMineId : setOppId}
        />
        {team?.note && <p className="estimated-note">〜 {team.note}</p>}
        <div className="row">
          <button onClick={() => startEdit(team?.text ?? "")}>コピーして改造</button>
          <button onClick={() => startEdit("")}>新規作成</button>
          {team?.group === "saved" && (
            <button className="danger" onClick={remove}>
              削除
            </button>
          )}
        </div>
      </section>
      {editing !== null && (
        <section className="card" aria-label="パーティの編集">
          <h2>パーティを編集</h2>
          <p className="muted small">
            ポケペースト形式（日本語可）。保存するとこの端末に残り、選出分析・対戦盤でそのまま使えます。
          </p>
          <input aria-label="パーティ名" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea
            aria-label="パーティのテキスト"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={14}
            spellCheck={false}
          />
          {editing.trim() && <MemberList text={editing} regulationId={regulationId} />}
          <div className="row">
            <button className="primary" onClick={save} disabled={!editing.trim()}>
              保存して使う
            </button>
            <button onClick={() => setEditing(null)}>やめる</button>
          </div>
        </section>
      )}
      {team && editing === null && (
        <section className="card">
          <h2>{team.name}</h2>
          <MemberList text={team.text} regulationId={regulationId} estimated={!!team.estimated} />
        </section>
      )}
    </div>
  );
}
