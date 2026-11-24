# CLAUDE.md — Champions Analyzer

Pokémon Champions ダブルバトル（VGC形式）の分析アプリ。計画は `docs/PLAN.md`、未確定事項は `docs/OPEN_QUESTIONS.md`、判断記録は `docs/adr/`。

## 最重要原則

- 対戦の判断（探索・評価）は、その時点でその側が**知り得る情報だけ**で行う。相手の非公開情報（未使用の技・持ち物・特性・配分・未登場の後ろ）は使用率から抽選した「ありうる世界」で扱い、実際の値を読まない（ADR-0012）。完全情報の探索は振り返り・比較用。

- 判定・数値（確定数、素早さ順、確率、勝ち筋）は決定的なコード（`calc` / `engine`）だけが出す。LLMは画像の読み取りとエンジン出力の文章化だけ（ADR-0004）。
- Finding には必ず evidence を1件以上（スキーマで強制）。推測は `kind: "heuristic"` / `basis: "estimated"` で区別する。
- ゲーム仕様の数値をコードに直接書かない。`packages/data/game/champions.json` かレギュレーションパックに書き、確認できていなければ `"verified": false` と `docs/OPEN_QUESTIONS.md` への記載。
- Claude API は使わない（追加費用ゼロ）。公式の画像・ロゴ・BGMは同梱しない。

## 構成

```
packages/schema   zodスキーマと型（依存: zodのみ）
packages/data     レギュレーションパック(JSON) + ローダー/検証/差分/雛形。`@ca/data/node` はNode専用(fs)
packages/calc     Champions の実数値の式（stats.ts、ここだけ）と @smogon/calc アダプター（damage.ts）
packages/ingest   Extractor インターフェースと Showdown/ポケペースト（日本語可）パーサ
packages/engine   ルールエンジン（rules/*.ts）、RuleContext、diagnose()、Mechanic プラグイン
packages/explain  Finding → 日本語（テンプレート）と LLM 出力の数値ガード
packages/sim      対戦シミュレーション（pokemon-showdown の champions mod）。policy.ts=行動方針と相手の「意図」、search.ts=毎ターンの読み合いの探索（ADR-0011）、belief.ts=その側が知り得る情報とありうる世界（ADR-0012）、reflection.ts=振り返り、tune.ts=重みの調整、bestplay.ts=最善手同士の対戦、analyze.ts=選出/択の分析、view.ts=画面用の局面と1手進める処理、pool.ts=並列実行(Node)
packages/cli      reg:* / data:* / team:check / calc（bin.ts が入口。各 *-commands.ts はテスト可能な部分）
apps/web          React + Vite（iPhone向け）。タブ: パーティ／選出分析／対戦盤／診断。診断は src/worker.ts、対戦は src/engine/（simWorker.ts を並列で動かす SimPool）。
                  Showdown は scripts/build-showdown.mjs でブラウザ用にバンドル（src/gen/、ビルド時に自動生成）。事前計算は src/data/（pnpm web:data）
(予定) apps/api
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
pnpm team:check <team.txt>                       # パーティを読み、実数値と問題点を表示
pnpm calc <team.txt> <攻撃側> <技> <防御側> [--mega] [--def-mega] [--weather Sun] [--def-team 相手.txt]
pnpm data:import-official <dir>                  # 公式「参加できるポケモン」ページ(保存済みHTML)→ 種族IDリスト
pnpm data:build-i18n --pokeapi <csv> --official <dir>  # names.json / base/moves.json を再生成
pnpm sim <自分.txt> <相手.txt> [--seed 1] [--scale 1] [--workers 4] [--json]  # 選出の読み合い・1ターン目の択
pnpm sim <自分.txt> pokedb:M-7:4                 # 上位構築（公開データ＋使用率で型を推定）が相手
pnpm sim:meta <自分.txt> [--top 10] [--scale 0.3] # M-C 上位構築すべてと対戦して推奨選出の一覧
pnpm report:meta <自分.txt> [--top 10]           # 上位構築との結果を画像(reports/*.png)にする（チャットで見せる用）
pnpm report:battle <自分.txt> <相手|pokedb:M-7:4> [--games 30]  # 1戦ごとの中身（評価値・選ぶ確率・出来事・HP）を画像に
pnpm report:replay <自分.txt> <相手|pokedb:M-7:68> [--pick lose|win] [--rollouts 16]  # 1戦を操作できる再生ページ(HTML1枚)＋各ターンの「もしこう動いていたら」勝率
pnpm report:book <自分.txt> [--top 10]           # 上位構築すべてと「両者が毎ターン勝率最大の行動を選ぶ」対戦をして、全部を1つのHTMLで再生
pnpm team:fill <下書き.txt> --candidates a,b,c [--top 6]  # 残り枠の候補ペアを上位構築との勝率で比較
pnpm team:pairs [--pool 30] [--opp 24] [--games 16] [--final 12]  # 使用率上位の2体の組み合わせを、よく一緒に使われる相手の2体と2対2で総当たり（上位は探索で再対戦）
pnpm team:build <核.txt> [--with a,b] --pool c,d,... [--tr] [--require trickroom] [--top 8]  # 核から6体を探索（4体→6体→最終評価）。--tr で遅いポケモンをトリル用の配分に
pnpm data:import-smogon <chaos.json> --month YYYY-MM  # Smogon 使用率(手動で一度だけ保存)→ usage/<reg>/
pnpm meta [--from 6] [--to 7] [--top 25] [--teams]  # 上位構築の採用率・組み合わせ・型（既定はレギュレーションのシーズン）
pnpm data:import-pokedb <dir>                    # pokedb 公開データ(手動で一度だけ保存したJSON)→ teams/pokedb/
pnpm sim:review <自分.txt> [--top 4] [--games 2] [--think 0.3] [--fit]  # 振り返り: 予想勝率と結果、相手の行動の予測、後から見た最善手との差（--fit で表示勝率の補正を weights.json へ）
pnpm sim:tune [--games 400] [--keys a,b] [--write]  # 行動方針の重みを1つずつ変え、同じ乱数・左右入れ替えの対局で明確に勝つ変更だけ採用
pnpm web:data --teams my-teams/a.txt,my-teams/b.txt [--top 8] [--scale 0.5] [--think 1]  # 重い計算をCLIで済ませてWebに同梱（選出分析＋最善手の対戦＋各局面の評価）
pnpm web:dev / pnpm web:build                    # Web 画面
pnpm e2e                                         # Playwright（iPhone 13 の画面サイズ、ビルドして preview で実行）
```

`CA_REGULATION`（既定 M-C）で team:check / calc のレギュレーションを切り替えられる。

`CA_REGULATIONS_DIR` でパックのディレクトリを差し替えられる。

## レギュレーションを追加する手順

原則としてコード変更なし、データの追加だけで済ませる（ADR-0002）。

1. `pnpm reg:new <新ID> --extends <現行ID>` で `packages/data/regulations/<新ID>/` を作る（中身は空の差分）。
   公式の「参加できるポケモン」ページがあれば、ja/en の `pokemon.html` を保存して `pnpm data:import-official <dir>` で種族IDを得て、現行リストとの差分を `legal.json` に書く。
2. `manifest.json`：表示名、`seasons`（例 `{ "from": 6 }`。採用率などの集計範囲の既定になる）、`periods.ranked` / `periods.official`、`dataVersion`（`YYYY-MM-DD.N`）、`sources`（出典URL・確認日）。新しい仕組みを有効/無効にするなら `mechanics.add` / `mechanics.remove`。
3. `legal.json`：親との差分だけを `{ "add": [...], "remove": [...] }` で書く（`species` / `megaSpecies` / `items` / `bannedMoves` / `bannedAbilities`）。メガ可能にする種族は `species` と `megaSpecies` の両方に入れ、メガストーンを `items` に入れる（入れないと検証エラー）。
4. `overrides.json`：バランス調整を項目単位で。変更するフィールドだけ書く。各エントリに `verified` と `sources`。親の調整を取り消すときは値を `null`。図鑑にない新種族は `newSpecies`。
5. `rules.json` / `weights.json`：変わる項目だけ書く（親と深いマージ。配列は置換）。
6. `pnpm reg:validate <新ID>` → `pnpm reg:diff <現行ID> <新ID>` で差分を目視確認。
7. 確認できない仕様は `verified: false` のままにし、`docs/OPEN_QUESTIONS.md` に追記。
8. 過去のパックは消さない（過去の対戦の再分析用）。分析結果には `regulationId` / `chain` / `dataVersion` / `contentHash` が記録される。
9. データだけで表現できない新しい仕組みが必要な場合のみ、`engine` に Mechanic プラグインを追加し（ADR を書く）、manifest の `mechanics` で有効にする。

## 規約

- **Git: 指定がない限り、変更は `main` に入れる**（作業ブランチでコミットしたら `main` にマージして push まで行う）。別ブランチに留める・PR にする場合はユーザーが指定する。

- 外部入力・データファイルはすべて zod で検証する。スキーマは `packages/schema`。
- 新しい判断は `docs/adr/NNNN-*.md`。フェーズごとに受け入れ条件をテストで確認してからコミット。
- テスト：単体は `packages/*/test/*.test.ts`。性質ベースは fast-check（プロパティ本体は `{ }` ブロックで書く。式の値を返すと失敗扱いになることがある）。
- 決定性：出力前にキーでソートし、ハッシュ・スナップショットは `canonicalJson` を通す。
- 実数値の式は `packages/calc/src/stats.ts` の `calcStat` だけに書く。アダプターは @smogon/calc が出した実数値をこれで上書きする。
- ゴールデン: `packages/calc/test/golden/ingame-stats.json` は実機の値（変更禁止）。`damage-cases.json` は独立実装の式で検証する。
- `legal.json` の `provenance` に、リストごとの出典と確度を書く。

## 自分のパーティ・相手のパーティ

- `my-teams/*.txt` に自分のパーティ（コピーして改造案を作る）、`opponents/*.txt` に対策したい構築（技構成込み）。
- シミュレーションの予算・行動方針の重みは `weights.json` の `simulation`。`--scale 2` で全段階の対戦数を2倍に。探索は `search*`、選出の強い評価は `strong*`。
- 新しいパーティは Web の「パーティ」タブで「コピーして改造」→保存すれば、その端末で選出分析・対戦盤にそのまま使える。リポジトリに残す案は `my-teams/` に置いて `pnpm web:data` で事前計算を更新。

## 外部データの扱い

- pokedb（champs.pokedb.tokyo）は**公開データ（/opendata/）だけ**を使う。使用率ページ・記事ページを取得するコードは書かない（ADR-0008）。
- 相手の技構成は Smogon 使用率（Showdown の Reg M-C）から推定（ADR-0010）。推定した項目は `assumed` と出力で明示する。
- 外部サイトには実行時にアクセスしない。取得したファイルは `data:*` コマンドで正規化してコミットする。

## ルールを追加・調整する手順

1. `packages/engine/src/rules/` に `Rule` を書き、`rules/index.ts` の `RULES` に追加。閾値は `params` に名前だけ宣言し、値は書かない。
2. 各レギュレーションの `weights.json` に `rules[ルールID]`（重み）と `params[ルールID]`（閾値）を追加。無いと `diagnose()` が RuleParamError で止まる（テストでも検出）。
3. `packages/explain/src/templates.ja.ts` に explainKey のテンプレート。本文に計算値を直書きしない（パラメータで渡す。性質ベーステストが検出）。
4. 分類が必要なら `packages/data/engine/tags.json`（技・特性の分類）に追加。
5. `pnpm test` → 診断のスナップショットが変わったら意図した変更か確認して `pnpm vitest run -u`。
