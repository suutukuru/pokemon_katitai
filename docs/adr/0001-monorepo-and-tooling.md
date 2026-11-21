# ADR-0001: pnpm モノレポとツール構成

- 状態: 採用
- 日付: 2026-11-21

## 背景

ブラウザ・Workers・ローカルCLIの3つの実行環境で、同じスキーマ・計算・エンジンを共有する必要がある。

## 決定

- pnpm workspaces。`packages/*` はビルドせず **TSソースを直接 export**（`main: src/index.ts`）。Vite / tsx / Vitest / wrangler はいずれもTSを直接扱えるため、ビルド工程を持たない。
- 型チェックはルートの `tsconfig.json` で全体を `tsc --noEmit`（`moduleResolution: bundler`、`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）。
- zod 4、Vitest、fast-check、ESLint 9（flat config + typescript-eslint）、Prettier。
- パッケージ名は `@ca/*`（Champions Analyzer の略。商標を含めない）。

## 影響

- 公開npmパッケージにする場合はビルド設定が別途必要（現状その予定はない）。
- `engine` / `calc` / `schema` は Node 専用API（fs, path, crypto）を使ってはいけない。ファイル読み込みは `data` の `PackSource` 経由。
