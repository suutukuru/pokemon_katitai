# データの出典とライセンス

## 依存OSS

| パッケージ                                                 | 用途                                                                  | ライセンス                                                                                                | 確認方法                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `@smogon/calc` 0.12.0                                      | ダメージ計算・基礎図鑑（第9世代の種族/技/特性/持ち物）                | MIT                                                                                                       | npm の `license` フィールド、リポジトリ github.com/smogon/damage-calc |
| `zod` 4.x                                                  | スキーマ検証                                                          | MIT                                                                                                       | npm                                                                   |
| `vitest` / `@vitest/coverage-v8`                           | テスト                                                                | MIT                                                                                                       | npm                                                                   |
| `fast-check`                                               | 性質ベーステスト                                                      | MIT                                                                                                       | npm                                                                   |
| `tsx`                                                      | TS実行（CLI）                                                         | MIT                                                                                                       | npm                                                                   |
| PokeAPI `data/v2/csv`（データのみ。npm依存ではない）       | 技・特性・持ち物・性格・タイプの ja/en 名、技の命中率・追加効果の確率 | BSD-3-Clause（著作権表示の保持が必要。"Pokémon and Pokémon character names are trademarks of Nintendo."） | リポジトリの LICENSE.md（2026-11-21 確認）                            |
| `typescript` / `typescript-eslint` / `eslint` / `prettier` | 開発ツール                                                            | Apache-2.0 / MIT / MIT / MIT                                                                              | npm                                                                   |

商用化前に `pnpm licenses list` で推移的依存も含めて再確認すること。

## ゲームデータ

| データ                                     | 出典                                                                                                                                                              | 扱い                                                 | ファイル                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 種族値・タイプ・技の威力                   | `@smogon/calc` 0.12.0（Pokémon Showdown 由来、MIT）                                                                                                               | 事実情報として利用。Champions差分は `overrides.json` | （ライブラリ内）                                                                             |
| SP 上限・計算式・Lv・個体値・性格補正      | ユーザー提供の実機スクショ（36値）＋攻略サイト                                                                                                                    | `verified:true`                                      | `packages/data/game/champions.json`、`packages/calc/test/golden/ingame-stats.json`           |
| M-C 使用可能ポケモン（262件）              | 公式「参加できるポケモン」 web-view.app.pokemonchampions.jp/battle/pages/events/rs178713870219xeaaio/{ja,en}/pokemon.html（2026-11-21取得、シングル シーズンM‐6） | 種族リストは公式。ダブルにも当てはまるかは未確認     | `packages/data/regulations/M-C/legal.json`、取得時点の写し `packages/data/sources/official/` |
| M-C メガシンカ可能・持ち物                 | 仮の値                                                                                                                                                            | `verified:false`（Q-13/Q-14）                        | 同上                                                                                         |
| ギルガルドの種族値                         | `@smogon/calc` 第8世代データ                                                                                                                                      | `verified:false`（Q-15）                             | `M-C/overrides.json`                                                                         |
| 日本語名（種族）                           | 公式ページ（フォルム名を含む）＋ PokeAPI                                                                                                                          | ja はゲーム内表記（かな）                            | `packages/data/i18n/names.json`                                                              |
| 日本語名（技・特性・持ち物・性格・タイプ） | PokeAPI `*_names.csv`（ja-Hrkt、NFKC正規化）                                                                                                                      | 新メガストーン46個は ja 名なし（Q-16）               | 同上                                                                                         |
| 技の命中率・追加効果の確率・対象           | PokeAPI `moves.csv`                                                                                                                                               | 本編の値。Champions の調整は `overrides.json`        | `packages/data/base/moves.json`                                                              |

| 上位構築（ダブル M-1〜M-7、226件）：順位・レート・ポケモン・持ち物 | バトルデータベース チャンピオンズ 上位構築データ（公開データ）https://champs.pokedb.tokyo/guide/opendata（2026-11-21取得、各シーズン1回のみ） | 公開データのみ使用。使用率ページ・記事は取得しない（ADR-0008、規約第3条: OPEN_QUESTIONS L-07） | `packages/data/teams/pokedb/` |
| 新メガストーンの日本語名（20個） | 上記の公開データ（持ち主から一意に特定） | 補完のみ（上書きしない） | `packages/data/i18n/names.extra.json` |

再生成手順: PokeAPI の CSV と公式ページ（`pokemon_ja.html` / `pokemon_en.html`）をローカルに保存し、
`pnpm data:build-i18n --pokeapi <csvディレクトリ> --official <ページのディレクトリ>`。自動巡回はしない。

## 同梱しないもの

公式のスプライト・画像・ロゴ・BGM・フォント。UIのアイコンはすべて自作またはライセンスの明確な汎用アイコンを使う。
