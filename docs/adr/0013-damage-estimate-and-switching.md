# ADR-0013: 補正込みのダメージ見積もり（R-4）と交代（R-5）

- 状態: 採用（R-4 は仕組みのみ・既定は無効。docs/sim-eval/README.md）
- 日付: 2026-11-28

## 決定

- R-4: 方針のダメージ見積もりに Showdown 自身の `battle.actions.getDamage` を使う方式を追加（`showdownDamage()`、`weights.simulation.damageModel = 1`）。`runMove` と同じく ModifyType / ModifyMove を先に通し、乱数は平均（92.5%）、急所は確定急所の技だけ、PRNG と `activeMove` 等は呼び出し後に戻す。自前の式（`damageModel = 0`）は残す。
  探索との一致が下がったため既定は 0。実戦の記録がそろったら測り直す。
- R-5: 倒れた後などの交代は、控えの各候補について「場の相手に与えられる最大の割合 − 受ける最大の割合 + 先に動ける相手の割合」（`switchOffenseWeight` / `switchDefenseWeight` / `switchSpeedWeight`）が最大の組み合わせを出す（`forcedSwitchModel = 1`、採用）。
  自分からの交代には、有利さの差（`switchMatchupWeight`）、最大の脅威を半減以下で受けられる控え（`switchResistBonus` / `switchResistRatio`）、相手に物理技があるときのいかく持ち（`intimidateCycleBonus`、採用 0.1）を加える。
- 交代の選び方を測るため、先生役の局面集に「交代の指示」の局面を追加できるようにした（`sim:teacher build --kinds switch`、`docs/sim-eval/teacher-switches.json`）。

## 影響

- 倒れた後の交代が変わるため、選出の勝率表・択の表・最善手の探索の数値は以前と変わる。
