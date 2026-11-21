# 自分のパーティ

ポケペースト形式（日本語可、`SPs:` 行で SP を指定）で1ファイル1パーティ。ファイルをコピーして書き換えるだけで別案を試せます。

```sh
pnpm team:check my-teams/team1.txt                       # 読み取り確認と実数値
pnpm sim my-teams/team1.txt opponents/sample-rain.txt     # 対戦シミュレーション（選出・初手・1ターン目の択）
pnpm sim my-teams/team1-v2.txt opponents/sample-rain.txt  # 改造案と比べる
```
