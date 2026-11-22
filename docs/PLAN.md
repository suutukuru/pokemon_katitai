# Champions Analyzer 実装計画

最終更新: 2026-11-21 / 対象: Pokémon Champions ダブルバトル（VGC形式）

## 進捗

| フェーズ                       | 状態                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| 1 基盤                         | 完了                                                                   |
| 2 ダメージ計算とテキスト入力   | 完了（実機ダメージとの照合のみ未実施: OPEN_QUESTIONS Q-03）            |
| 3 パーティ診断                 | 完了                                                                   |
| 4 構築DB・対戦シミュレーション | 完了（探索・最善手同士の対戦・選出の強い評価: ADR-0009/0011）          |
| Web 対戦盤（iPhone）           | 完了（パーティ／選出分析／対戦盤／診断。端末内で並列シミュレーション） |

## 1. 基本方針

| 原則                                            | 具体化                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 判断は決定的なエンジン、LLMは読み取りと説明だけ | `calc` / `engine` は純粋関数。LLMの出力はzodで検証し、数値の新規生成を検出したら破棄（`explain` の検証器）                                     |
| 根拠のないFindingは出さない                     | スキーマで `evidence: [Evidence, ...Evidence[]]`（1件以上）を型レベルで強制。性質ベーステストでも確認                                          |
| 推測と計算を区別                                | `Evidence.kind = "calc" \| "data" \| "heuristic"`、`Finding.basis = "computed" \| "estimated"`。UIは記号＋ラベル＋色で区別（色だけに頼らない） |
| レギュレーション追加はデータだけ                | `packages/data/regulations/<id>/` の5ファイル + `extends` 継承。コードを触るのは新しい仕組み（Mechanic）が必要な時だけ                         |
| 再現性                                          | すべての分析結果に `AnalysisMeta { regulationId, regulationChain, dataVersion, contentHash, usageSnapshot, engineVersion, seed }` を付ける     |
| 追加費用ゼロ                                    | Claude APIを使わない。スクショ読取は Claude Code スラッシュコマンド経由。抽出器はインターフェースで抽象化                                      |

## 2. 構成

```
packages/
  schema/   zodスキーマと型。依存はzodのみ（全パッケージの最下層）
  data/     レギュレーションパック・構築DB・使用率スナップショット(JSON) + ローダー/検証/差分
  calc/     @smogon/calc アダプター（Champions仕様、SP⇔実数値）。式はここ1か所
  engine/   Mechanicプラグイン、ルールエンジン、型判定、探索(expectimax)、評価関数
  explain/  Finding/Scenario → 文章（テンプレート、決定的）。LLM整形は任意プラグイン
  ingest/   Extractor（Showdownテキスト / Claude Codeスクショ / 将来OCR・API）
  cli/      reg:new / reg:diff / reg:validate / data:import-team / ingest:screenshot / diagnose
apps/
  web/      React + Vite（Cloudflare Pages）。重い処理は Web Worker で engine を実行
  api/      Hono on Workers + D1（ユーザーのパーティ保存、エクスポート/削除）。認証は後付け可能な層
```

依存の向き: `schema ← data ← calc ← engine ← explain`、`ingest → schema,data`、`cli/web/api → すべて`。
engine はブラウザでも動く必要があるため Node 依存（fs 等）を持たない。`data` のファイル読み込みは
`PackSource` インターフェース（Node: fs実装 / ブラウザ: ビルド時に埋め込んだJSON実装）で抽象化する。

### ID 規約

種族・技・特性・持ち物は Showdown 互換の `toID`（小文字英数字のみ。例 `Charizard-Mega-Y` → `charizardmegay`）を正とする。
表示名は i18n 表（`packages/data/i18n/{ja,en}.json`）から引く。

## 3. フェーズ

各フェーズは「受け入れ条件をテストで満たす → コミット」で区切る。

### フェーズ1：基盤（このセッションで実装）

- pnpm モノレポ、TS strict、ESLint(flat) + Prettier、Vitest、GitHub Actions CI
- `schema`：RegulationPack 関連、Finding/Evidence、AnalysisMeta、Team/Pokemon の初版
- `data`：パック読み込み（`extends` 連鎖の解決・循環検出・zod検証・参照整合性検証・コンテンツハッシュ）
- 基礎図鑑（Dex）：`@smogon/calc` の第9世代データ + パックの `overrides.newSpecies` 等
- CLI：`reg:new <id> --extends <parent>`、`reg:diff <a> <b>`、`reg:validate [id]`
- パック：`M-C`（公式の使用可能ポケモン262件。ADR-0006 で仮パック M-B から置き換え）と `X-NEXT-DUMMY`（差分のみのダミー）
- 受け入れ条件：両パックが読める / 不正パック（存在しない種族・技・持ち物、循環継承、存在しない親、スキーマ違反）で正しいエラー

### フェーズ2：ダメージ計算とテキスト入力（完了）

結果:

- 実数値: ユーザー提供の実機スクショ6体×6ステータス=**36件すべて一致**（`calc/test/golden/ingame-stats.json`）。SPの式・上限を `verified:true` に。
- ダメージ: 手で条件を書いた**15件**で、アダプター（@smogon/calc）と「公開された第5世代以降の式の独立実装」が16段階すべて一致（範囲技・天気・急所・メガ・4倍弱点を含む）。**Champions実機のダメージ値との照合は未実施**（実機の計算例が無いため。Q-03）。
- 命中率は @smogon/calc に無いことがテストで判明 → PokeAPI から補完（ADR-0005）。
- テキスト入力: 日本語のポケペーストを読み、実機のチームと完全一致。全角/ひらがな/誤字の補正と候補提示、EVs→SP 換算、不明項目の `assumed`。
- CLI: `pnpm team:check`、`pnpm calc`。

当初の計画:

- `calc`：SP→実数値（式は `game/champions.json` の定数を参照）、overrides の適用（種族値・技威力等を `@smogon/calc` 呼び出し前に差し替え）、乱数16段階のダメージ分布を返すAPI、確定数と KO 確率（急所・命中込み）
- `ingest`：Showdown形式パーサ（`SPs:` 拡張行を定義。EVs のみなら換算して警告）
- ゴールデンテスト：既知の計算例10件以上。**注意**：Champions実機の検証済み計算例はまだ入手できていない（OPEN_QUESTIONS Q-03）。まずは「SV仕様での @smogon/calc 出力 = 公開計算機の出力」と「SP換算の手計算例」で固定し、実機値が入手でき次第差し替える。一致しない場合は理由を記録

### フェーズ3：パーティ診断（完了）

結果:

- `engine`：Rule インターフェース、RuleContext、`diagnose()`、Mechanic プラグイン（`mega`）。ルール15個、重み・閾値・重要度の境界はすべて `weights.json`（`rules` / `params` / `severity`）。
- `explain`：日本語テンプレート、根拠の表示、LLM整形用の数値ガード（入力にない数値を含む文は破棄）。テンプレート自身が数値を作っていないことを性質ベーステストで確認。
- Web：React + Vite、診断は Web Worker（ユーザーのパーティで約50ms）。重要度は記号＋文字＋色、推測は点線＋「〜 推測を含む」で区別。端末内保存・JSON書き出し・全削除。
- 受け入れ: サンプル3パーティ（ユーザーのチーム1、サンプルのトリル・あめ）で根拠つきFindingが重要度順に出ることを Vitest と Playwright（Pixel 7 表示）で確認。結果はスナップショットで固定。
- 使用率データが無いため、`offense.threats` / `defense.threats` は使用率スナップショットを渡したときだけ動く（テスト用の架空データで動作確認済み）。

当初の計画:

- Rule インターフェース（宣言的）、`weights.json` 駆動のスコア、Finding 生成
- 初期ルール（下記 §5）、`explain` テンプレート（ja）、Web画面（Finding一覧：重要度順・カテゴリ絞り込み・根拠展開）
- 改善案は「変更して再計算した結果」がある場合のみ出す（反実仮想の再評価）
- 受け入れ条件：サンプル3パーティで根拠つきFindingが重要度順に表示される（E2E 1本）

### フェーズ4：構築DBと対策プラン

- `data/teams/` に10件以上（出典・大会・順位・日付・公開範囲）。**未検証の実在構築は入れず**、出典が確認できない間は `sample: true` のサンプル構築を使う
- 型判定（archetype rules をデータで定義）、勝ち筋テンプレート
- 探索：初手 C(4,2)=6 × 相手初手（頻度上位K）× 深さ1〜3。同時手番の expectimax（相手行動は事前分布、乱数/急所/命中/追加効果はチャンス節点）。ビーム幅と枝刈りログ
- 評価関数：特徴量（HP割合、場の数、素早さ操作の残りターン、メガの残り、など）× `weights.json`
- 決定性テスト（同じ入力で同じJSON、seed固定）
- Web：分岐ツリー（折りたたみ）、Web Worker 実行

### フェーズ5：スクショ取り込み

実機の「能力」タブ（種族・性別・特性・持ち物・技）と「ステータス」タブ（実数値・SP・性格の↑↓）の2枚で、
パーティの全情報が読める（2026-11-21 のスクショで確認）。性格は↑↓から `natureFrom()` で決まり、
読み取った実数値と SP から計算した実数値の一致で**読み取りミスを検出**できる（`inferSp()`）。

- `.claude/commands/ingest-team.md`（JSONのみ出力の厳密指示 + スキーマ）
- `pnpm ingest:screenshot <dir>` → Claude Code 実行 → zod検証 → あいまい一致補正（Levenshtein/かな正規化で候補提示）
- confidence と `assumed` の確認・修正画面

### フェーズ6以降

- 対戦ログ手入力フォーマット → 各ターンの期待値差分の指摘
- 動画：ffmpeg フレーム切り出し → Extractor（インターフェースのみ）
- 重み学習（ロジスティック回帰、`weights.json` に新バージョンとして保存、手動版と比較レポート）
- LLMでの文章改善（入力にない数値を含む出力は破棄）

## 4. レギュレーションパックの設計（要約。詳細は ADR-0002）

`packages/data/regulations/<id>/`

- `manifest.json`：id、表示名(ja/en)、`extends`、期間（`ranked` / `official` を分離）、`mechanics`（有効にするプラグインID）、`dataVersion`、`sources[]`、`verified`
- `legal.json`：`species` / `megaSpecies` / `items` / `bannedMoves` / `bannedAbilities` をそれぞれ `{ add: [], remove: [] }` の差分で記述。ルートパックは `add` が全量
- `overrides.json`：`species` / `moves` / `abilities` / `items` の項目単位の差分。各項目に `verified` と `source`
- `rules.json`：形式（doubles、6→4、Lv50、種族/持ち物クローズ、時間）。部分指定で親にマージ
- `weights.json`：ルール重み・評価関数重み。`version` を持つ

継承の解決：ルート→子の順にマージ。集合は `(親 ∪ add) − remove`、オブジェクトは項目単位の深いマージ、配列は置換。
解決後の結果に `chain`（例 `["M-B","X-NEXT-DUMMY"]`）と `contentHash`（正規化JSONのSHA-256）を持たせ、分析結果に記録。

## 5. 初期ルール候補（フェーズ3）

| カテゴリ         | ルールID                                                     | 内容                                                                                     |
| ---------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| speedControl     | `speed-control.missing` / `.strength`                        | おいかぜ・トリル・こごえるかぜ・エレキネット・でんじは等の有無、到達できる行動順の改善幅 |
| speedControl     | `speed-tier.position`                                        | 使用率上位N体の最速/準速/無振り実数値に対する各ポケモンの位置                            |
| support          | `support.fakeout` `support.intimidate` `support.redirection` | ねこだまし・いかく・このゆび/いかりのこな の有無と被り                                   |
| defensiveSynergy | `defense.shared-weakness`                                    | 弱点の重なり（4倍弱点は重く）、一貫しているタイプ                                        |
| offense          | `offense.coverage` / `offense.ohko-top-n`                    | 上位N体への確定数分布、打点のないポケモン                                                |
| defensiveSynergy | `defense.survive-top-n`                                      | 上位N体の主要技を耐えられるか                                                            |
| mega             | `mega.slot-usage`                                            | メガ候補の数、メガ枠が選出を縛っていないか                                               |
| selection        | `selection.flexibility`                                      | C(6,4)=15通りのうち成立する選出の数と多様性                                              |
| matchup          | `matchup.archetype-answer`                                   | トリル・天候・おいかぜ・壁 等への回答の有無                                              |
| itemAbility      | `item.duplicate` `ability.conflict`                          | アイテムクローズ違反、特性の干渉（例：天候の打ち消し合い）                               |
| protect          | `protect.density`                                            | まもる系の採用数（ダブルの基本）                                                         |
| field            | `field.terrain-weather-conflict`                             | 自軍内の天候・フィールドの衝突                                                           |

## 6. 追加で気づいたリスクと改善案

1. **仕様情報の確度**：SPの上限や実数値計算式は二次情報（攻略サイト）ベース。実機での検証手段（スクショのステータス画面から逆算するテスト）をフェーズ2で用意する。
2. **@smogon/calc の更新追従**：npm の版は更新が遅れることがある。アダプターは calc の型を外に漏らさず、将来 `@pkmn/dmg` 等へ差し替え可能にする（ADR-0003）。
3. **探索の組み合わせ爆発**：ダブルは1ターンの合法手が 2体×(技4×対象3+まもる+交代2)²程度になる。ビーム幅・支配される手の除去・相手手の事前確率上位K件で制限し、何を切ったかをログに残す。
4. **相手の情報は不完全**：相手のSP・持ち物は不明なことが多い。使用率スナップショットから「型の分布」を作り、期待値で扱う（推測フラグ付き）。
5. **IP/規約**：公式画像を配信しない。ポケモン名の日本語表記は事実情報として扱うが、商用化前に法務確認（OPEN_QUESTIONS）。
6. **ブラウザでのデータサイズ**：@smogon/calc の全世代データは大きい。Web では第9世代のみを含むビルドに絞る（tree-shaking 不可の場合は自前で必要データを抽出してJSON化）。
7. **使用率データの入手性**：公式の使用率APIの有無が不明。手入力・CSVインポートを第一の経路にする。
8. **決定性**：`Map`/`Set` の反復順、浮動小数の加算順でも結果が変わり得る。出力前にキーでソートし、確率は有理数または固定小数で丸めてから比較する。
9. **ゴールデンテストの陳腐化**：パックの `contentHash` をスナップショットに含め、データ変更時に「意図した変更か」をレビューで判断できるようにする。

## 7. 成果物の場所

- 判断記録：`docs/adr/`
- 未確定事項：`docs/OPEN_QUESTIONS.md`
- データ出典とライセンス：`docs/DATA_SOURCES.md`
- 作業手順：`CLAUDE.md`
