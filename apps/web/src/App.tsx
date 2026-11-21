import { useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE_TEAMS } from "./samples";
import type { DiagnoseRequest, DiagnoseResponse, ErrorResponse } from "./protocol";
import { exportText, loadSaved, saveAll, type SavedTeam } from "./storage";

const SEVERITY_ICON: Record<string, string> = { critical: "⛔", major: "▲", minor: "●", info: "ℹ" };
const STAT_LABEL: Record<string, string> = {
  hp: "H",
  atk: "A",
  def: "B",
  spa: "C",
  spd: "D",
  spe: "S",
};
const ISSUE_LABEL = { error: "エラー", warning: "要確認", info: "情報" } as const;

type Result = DiagnoseResponse | null;

export function App() {
  const worker = useMemo(
    () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
    [],
  );
  const seq = useRef(0);
  const [text, setText] = useState(SAMPLE_TEAMS[0]?.text ?? "");
  const [regulationId, setRegulationId] = useState("M-C");
  const [result, setResult] = useState<Result>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<string>("all");
  const [saved, setSaved] = useState<SavedTeam[]>(() => loadSaved());
  const [teamName, setTeamName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState("");

  useEffect(() => {
    worker.onmessage = (ev: MessageEvent<DiagnoseResponse | ErrorResponse>) => {
      if (ev.data.id !== seq.current) return;
      setBusy(false);
      if (ev.data.type === "error") setError(ev.data.message);
      else {
        setError(null);
        setResult(ev.data);
      }
    };
    return () => worker.terminate();
  }, [worker]);

  const run = () => {
    seq.current += 1;
    setBusy(true);
    const req: DiagnoseRequest = { type: "diagnose", id: seq.current, text, regulationId };
    worker.postMessage(req);
  };

  // In-page controls only: prompt()/confirm() and file downloads are unavailable in some hosts.
  const saveCurrent = () => {
    const name =
      teamName.trim() ||
      result?.members
        .map((m) => m.name)
        .slice(0, 2)
        .join("・") ||
      "チーム";
    const next = [
      ...saved,
      { id: `t${Date.now()}`, name, text, regulationId, savedAt: new Date().toISOString() },
    ];
    setSaved(next);
    saveAll(next);
    setTeamName("");
  };
  const removeSaved = (id: string) => {
    const next = saved.filter((t) => t.id !== id);
    setSaved(next);
    saveAll(next);
  };
  const deleteAll = () => {
    setSaved([]);
    saveAll([]);
    setConfirmDelete(false);
    setExported(null);
  };
  const copyExport = async () => {
    const json = exportText(saved);
    setExported(json);
    try {
      await navigator.clipboard.writeText(json);
      setCopyNote("コピーしました");
    } catch {
      setCopyNote("下の欄を長押しして全選択・コピーしてください");
    }
  };

  const categories = [...new Set(result?.explained.map((f) => f.category) ?? [])];
  const findings = (result?.explained ?? []).filter(
    (f) => category === "all" || f.category === category,
  );

  return (
    <div className="app">
      <header>
        <h1>Champions Analyzer（仮）</h1>
        <p className="sub">
          ダブルバトルのパーティ診断。判定はすべて計算で出し、根拠を表示します。
        </p>
      </header>

      <section aria-labelledby="input-h" className="card">
        <h2 id="input-h">パーティ</h2>
        <div className="row">
          <label>
            サンプル
            <select
              aria-label="サンプルのパーティ"
              onChange={(e) =>
                setText(SAMPLE_TEAMS.find((t) => t.id === e.target.value)?.text ?? text)
              }
              defaultValue={SAMPLE_TEAMS[0]?.id}
            >
              {SAMPLE_TEAMS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            レギュレーション
            <select
              aria-label="レギュレーション"
              value={regulationId}
              onChange={(e) => setRegulationId(e.target.value)}
            >
              {(result?.regulations ?? [{ id: "M-C", name: "M-C" }]).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          aria-label="パーティのテキスト（ポケペースト形式）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
        />
        <div className="row">
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? "診断中…" : "診断する"}
          </button>
          <input
            id="team-name"
            aria-label="保存するチーム名"
            placeholder="チーム名（省略可）"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
          />
          <button onClick={saveCurrent} disabled={!text.trim()}>
            この端末に保存
          </button>
        </div>
        {saved.length > 0 && (
          <details className="saved">
            <summary>保存したチーム（{saved.length}）</summary>
            <ul>
              {saved.map((t) => (
                <li key={t.id}>
                  <button
                    className="link"
                    onClick={() => {
                      setText(t.text);
                      setRegulationId(t.regulationId);
                    }}
                  >
                    {t.name}
                  </button>
                  <span className="muted">
                    {" "}
                    {t.regulationId} / {t.savedAt.slice(0, 10)}
                  </span>
                  <button
                    className="small"
                    aria-label={`${t.name}を削除`}
                    onClick={() => removeSaved(t.id)}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
            <div className="row">
              <button onClick={copyExport}>書き出し（JSONをコピー）</button>
              {confirmDelete ? (
                <>
                  <button className="danger" onClick={deleteAll}>
                    本当にすべて削除する
                  </button>
                  <button onClick={() => setConfirmDelete(false)}>やめる</button>
                </>
              ) : (
                <button className="danger" onClick={() => setConfirmDelete(true)}>
                  すべて削除
                </button>
              )}
            </div>
            {copyNote && <p className="muted">{copyNote}</p>}
            {exported && (
              <textarea
                id="export-json"
                aria-label="書き出したJSON"
                readOnly
                rows={6}
                value={exported}
                onFocus={(e) => e.currentTarget.select()}
              />
            )}
          </details>
        )}
      </section>

      {error && (
        <p role="alert" className="card error">
          エラー: {error}
        </p>
      )}

      {result && (
        <>
          {result.issues.length > 0 && (
            <section aria-labelledby="issues-h" className="card">
              <h2 id="issues-h">読み取りの確認（{result.issues.length}件）</h2>
              <ul className="issues">
                {result.issues.map((i, k) => (
                  <li key={k} className={`issue ${i.severity}`}>
                    <strong>[{ISSUE_LABEL[i.severity]}]</strong>{" "}
                    {i.line !== undefined ? `${i.line}行目: ` : ""}
                    {i.message}
                    {i.candidates && i.candidates.length > 0 && (
                      <span className="muted">
                        （候補: {i.candidates.map((c) => c.label).join(" / ")}）
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.members.length > 0 && (
            <section aria-labelledby="members-h" className="card">
              <h2 id="members-h">メンバーと実数値</h2>
              <ul className="members">
                {result.members.map((m, k) => (
                  <li key={k} className="member">
                    <div className="member-head">
                      <strong>{m.formeName}</strong>
                      {m.mega && <span className="tag">メガシンカ後</span>}
                      <span className="muted">
                        {m.item} / {m.ability} / {m.nature}
                      </span>
                    </div>
                    <div className="stats">
                      {Object.entries(m.stats).map(([s, v]) => (
                        <span key={s} className="stat">
                          <abbr title={s}>{STAT_LABEL[s]}</abbr> {v}
                          <small>({m.sp[s]})</small>
                        </span>
                      ))}
                    </div>
                    <div className="muted">{m.moves.join(" / ")}</div>
                    {(m.assumed.length > 0 || m.lowConfidence.length > 0) && (
                      <div className="estimated-note">
                        ⚠ 推測を含む:{" "}
                        {[
                          ...m.assumed.map((a) => `${a}（仮の値）`),
                          ...m.lowConfidence.map((a) => `${a}（読み替え）`),
                        ].join("、")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result.report && (
            <section aria-labelledby="findings-h" className="card">
              <h2 id="findings-h">
                診断結果 <span className="score">スコア {result.report.score}</span>
              </h2>
              <div className="chips" role="group" aria-label="カテゴリで絞り込み">
                {["all", ...categories].map((c) => (
                  <button
                    key={c}
                    className={`chip ${category === c ? "on" : ""}`}
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                  >
                    {c === "all" ? "すべて" : c}
                  </button>
                ))}
              </div>
              {findings.length === 0 && <p className="muted">指摘はありません。</p>}
              <ol className="findings">
                {findings.map((f, k) => (
                  <li
                    key={k}
                    className={`finding sev-${f.severity} basis-${f.basis}`}
                    data-testid="finding"
                    data-severity={f.severity}
                  >
                    <div className="finding-head">
                      <span className={`sev sevbadge-${f.severity}`}>
                        <span aria-hidden="true">{SEVERITY_ICON[f.severity]}</span>{" "}
                        {f.severityLabel}
                      </span>
                      <span className="tag">{f.category}</span>
                      <span className={`basis ${f.basis}`}>
                        {f.basis === "computed" ? "✓ 計算結果" : "〜 推測を含む"}
                      </span>
                    </div>
                    <h3>{f.title}</h3>
                    <p>{f.body}</p>
                    {f.suggestions.map((s, j) => (
                      <p key={j} className="suggestion">
                        💡 <strong>{s.title}</strong>：{s.body}
                      </p>
                    ))}
                    <details>
                      <summary>根拠（{f.evidence.length}）</summary>
                      {f.evidence.map((e, j) => (
                        <div key={j} className={`evidence ev-${e.kind}`}>
                          <div className="ev-label">
                            [{e.kind === "calc" ? "計算" : e.kind === "data" ? "データ" : "推測"}]{" "}
                            {e.label}
                          </div>
                          <ul>
                            {e.lines.map((l, i) => (
                              <li key={i}>{l}</li>
                            ))}
                          </ul>
                          {e.source && <div className="muted">出典: {e.source}</div>}
                        </div>
                      ))}
                    </details>
                  </li>
                ))}
              </ol>
              <p className="meta muted">
                レギュレーション {result.report.meta.regulationId}（
                {result.report.meta.regulationChain.join(" → ")}）/ データ{" "}
                {result.report.meta.dataVersion} / {result.report.meta.contentHash} / エンジン{" "}
                {result.report.meta.engineVersion}
                {result.report.meta.usageSnapshot
                  ? ` / 使用率 ${result.report.meta.usageSnapshot}`
                  : " / 使用率データなし"}{" "}
                / {result.ms}ms
              </p>
            </section>
          )}
        </>
      )}
      <footer className="muted">
        非公式のファン作成ツールです。ゲーム内の画像・ロゴは使用していません。データの出典は
        docs/DATA_SOURCES.md を参照。
      </footer>
    </div>
  );
}
