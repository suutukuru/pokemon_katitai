# 自分のパーティ

ポケペースト形式（日本語可、`SPs:` 行で SP を指定）で1ファイル1パーティ。ファイルをコピーして書き換えるだけで別案を試せます。

```sh
pnpm team:check my-teams/team1.txt                       # 読み取り確認と実数値
pnpm sim my-teams/team1.txt opponents/sample-rain.txt     # 対戦シミュレーション（選出・初手・1ターン目の択）
pnpm sim my-teams/team1-v2.txt opponents/sample-rain.txt  # 改造案と比べる
```

## スマホ（Web）で試す

- Web の「パーティ」タブで、このフォルダのパーティを選んで「コピーして改造」→「保存して使う」。その端末だけに保存され、
  「選出分析」（端末内で並列シミュレーション）と「対戦盤」（1手ずつ自分で選んで、その場で勝率を評価）にそのまま使えます。
- リポジトリに残す案はこのフォルダに置き、重い計算を CLI で済ませておくとスマホですぐ表示されます:

```sh
pnpm web:data --teams my-teams/team2.txt,my-teams/新しい案.txt --top 8
pnpm web:build
```
