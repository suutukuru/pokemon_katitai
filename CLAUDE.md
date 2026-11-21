# CLAUDE.md — Champions Analyzer

Pokémon Champions ダブルバトル（VGC形式）の分析アプリ。計画は `docs/PLAN.md`、未確定事項は `docs/OPEN_QUESTIONS.md`、判断記録は `docs/adr/`。

## 最重要原則

- 判定・数値（確定数、素早さ順、確率、勝ち筋）は決定的なコード（`calc` / `engine`）だけが出す。LLMは画像の読み取りとエンジン出力の文章化だけ（ADR-0004）。
- Finding には必ず evidence を1件以上（スキーマで強制）。推測は `kind: "heuristic"` / `basis: "estimated"` で区別する。
- ゲーム仕様の数値をコードに直接書かない。`packages/data/game/champions.json` かレギュレーションパックに書き、確認できていなければ `"verified": false` と `docs/OPEN_QUESTIONS.md` への記載。
- Claude API は使わない（追加費用ゼロ）。公式の画像・ロゴ・BGMは同梱しない。

## 構成

```
packages/schema   zodスキーマと型（依存: zodのみ）
packages/data     レギュレーションパック(JSON) + ローダー/検証/差分/雛形。`@ca/data/node` はNode専用(fs)
packages/cli      reg:new / reg:diff / reg:validate（bin.ts が入口、commands.ts はテスト可能な純粋部分）
(予定) calc engine explain ingest / apps/web apps/api
```

- パッケージはビルドせず TS ソースを直接 export（ADR-0001）。
- `schema` / `calc` / `engine` / `explain` では `node:*`・fs・path・crypto を import しない（ESLintで禁止）。
- ID は Showdown 互換 `toID`（小文字英数字のみ）。JSONには表示名で書いてもローダーが正規化する。

## コマンド

```sh
pnpm install
pnpm test              # Vitest（全パッケージ）
pnpm test:coverage     # カバレッジ（calc/engine は90%以上が目標）
pnpm typecheck         # tsc --noEmit（strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes）
pnpm lint              # ESLint
pnpm format            # Prettier（書き換え） / pnpm format:check
pnpm ci                # format:check + lint + typecheck + test
pnpm reg:validate [id] # パックの検証（引数なしで全パック）
pnpm reg:diff <a> <b> [--json]
pnpm reg:new <id> --extends <parent> [--name-ja ..] [--name-en ..]
```

`CA_REGULATIONS_DIR` でパックのディレクトリを差し替えられる。

## レギュレーションを追加する手順

原則としてコード変更なし、データの追加だけで済ませる（ADR-0002）。

1. `pnpm reg:new <新ID> --extends <現行ID>` で `packages/data/regulations/<新ID>/` を作る（中身は空の差分）。
2. `manifest.json`：表示名、`periods.ranked` / `periods.official`、`dataVersion`（`YYYY-MM-DD.N`）、`sources`（出典URL・確認日）。新しい仕組みを有効/無効にするなら `mechanics.add` / `mechanics.remove`。
3. `legal.json`：親との差分だけを `{ "add": [...], "remove": [...] }` で書く（`species` / `megaSpecies` / `items` / `bannedMoves` / `bannedAbilities`）。メガ可能にする種族は `species` と `megaSpecies` の両方に入れ、メガストーンを `items` に入れる（入れないと検証エラー）。
4. `overrides.json`：バランス調整を項目単位で。変更するフィールドだけ書く。各エントリに `verified` と `sources`。親の調整を取り消すときは値を `null`。図鑑にない新種族は `newSpecies`。
5. `rules.json` / `weights.json`：変わる項目だけ書く（親と深いマージ。配列は置換）。
6. `pnpm reg:validate <新ID>` → `pnpm reg:diff <現行ID> <新ID>` で差分を目視確認。
7. 確認できない仕様は `verified: false` のままにし、`docs/OPEN_QUESTIONS.md` に追記。
8. 過去のパックは消さない（過去の対戦の再分析用）。分析結果には `regulationId` / `chain` / `dataVersion` / `contentHash` が記録される。
9. データだけで表現できない新しい仕組みが必要な場合のみ、`engine` に Mechanic プラグインを追加し（ADR を書く）、manifest の `mechanics` で有効にする。

## 規約

- 外部入力・データファイルはすべて zod で検証する。スキーマは `packages/schema`。
- 新しい判断は `docs/adr/NNNN-*.md`。フェーズごとに受け入れ条件をテストで確認してからコミット。
- テスト：単体は `packages/*/test/*.test.ts`。性質ベースは fast-check（プロパティ本体は `{ }` ブロックで書く。式の値を返すと失敗扱いになることがある）。
- 決定性：出力前にキーでソートし、ハッシュ・スナップショットは `canonicalJson` を通す。
