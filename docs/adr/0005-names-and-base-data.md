# ADR-0005: 日本語名・補助データの出典と名前の揺れの補正

- 状態: 採用
- 日付: 2026-11-21

## 背景

入力（ポケペースト、スクショ）は日本語のことが多く、表記揺れ（全角/半角、ひらがな/カタカナ、誤字）がある。
`@smogon/calc` は日本語名も技の命中率も持っていない（命中率が無いことはテストで発覚した）。

## 決定

- 名前の表 `packages/data/i18n/names.json` を生成物としてコミットする。
  - 種族名は公式サイトの「参加できるポケモン」（フォルム名つき）を優先し、それ以外は PokeAPI の ja-Hrkt（ゲーム内のかな表記）。
  - PokeAPI の全角英数字は NFKC で半角にする（ゲーム画面の表記に合わせる）。
  - 基礎図鑑（@smogon/calc 第9世代 + パックの newSpecies）に存在する ID だけを残す。
- 技の命中率・追加効果の確率・対象は PokeAPI `moves.csv` から `packages/data/base/moves.json` を生成する。Champions の調整はパックの `overrides.moves` が優先。
- 名前の解決（`resolveName`）: NFKC・かな統一・記号除去で正規化 → 完全一致 → 編集距離による候補。距離が文字数の1/3を超えたら**推測せず**候補だけ返す。レギュレーションの使用可能リストで候補を絞れる。
- 外部サイトからは自動取得しない。ユーザーが保存したファイルを `pnpm data:build-i18n` / `pnpm data:import-official` で取り込む。

## 影響

- PokeAPI の BSD-3-Clause 表示を `docs/DATA_SOURCES.md` に記載。商用化時の扱いは OPEN_QUESTIONS L-04/L-05。
- 新メガストーンなど PokeAPI に日本語名が無いものは英語名で表示される（OPEN_QUESTIONS Q-16）。
