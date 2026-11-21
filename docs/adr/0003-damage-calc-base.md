# ADR-0003: ダメージ計算のベースに @smogon/calc を採用し、アダプター層で Champions 差分を吸収

- 状態: 採用（フェーズ2で再評価）
- 日付: 2026-11-21

## 背景

Champions 対応の公開ライブラリの有無を調査した（2026-11-21、Web検索）。

- `@smogon/calc` 0.12.0（MIT）: Champions 専用モードはないが、第9世代データに Z-A 由来の新メガ（例: Dragonite-Mega, Clefable-Mega, 新メガストーン）が含まれている。
- Pikalytics / ChampDex 等の Web 計算機は Smogon calc のフォークを名乗るが、npm パッケージとしての提供やライセンスは未確認。ChampDex は「Smogon と意図的に異なる計算をする箇所がある」と表明している（独立検証はしていない）。
- `@pkmn/dmg` は後継とされるが Champions 対応は不明。

## 決定

- `@smogon/calc` を依存として使い、**ライブラリは書き換えない**。
- `packages/calc` に Champions アダプターを置く: SP→実数値（式は `game/champions.json` の定数を参照）、パック `overrides` を適用した Species/Move を構築して calc に渡す、calc の型をパッケージ外へ漏らさない。
- calc で表現できない差分は、アダプターで前処理/後処理するか Mechanic プラグインの `modifyDamage` で扱う。

## 影響

- 基礎図鑑（Dex）もフェーズ1から `@smogon/calc` の第9世代データを使う（参照整合性検証のため）。
- Champions 専用フォークが MIT 等で公開されたら再評価する。
