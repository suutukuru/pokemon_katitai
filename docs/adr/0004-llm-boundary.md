# ADR-0004: LLM の利用範囲と追加費用ゼロの抽出

- 状態: 採用
- 日付: 2026-11-21

## 決定

- LLM は (a) 画像からの情報抽出、(b) エンジン出力の文章化、の2つにのみ使う。判定・数値は作らせない。
- Claude API は使わない。スクショ抽出は Claude Code のスラッシュコマンド（`.claude/commands/ingest-team.md`）をローカルで実行し、JSON のみを出力させる。
- `ingest` の `Extractor` インターフェース: `extract(input) → Promise<ExtractionResult>`（項目ごとの confidence 付き）。実装: `showdown-text`、`claude-code-cli`、将来 `local-ocr`、`api`。
- 文章化の LLM 整形は任意。入力（構造化データ）に含まれない数値トークンが出力に現れたら破棄し、テンプレート文にフォールバックする。
