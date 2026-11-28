# ADR-0012: 行動順（R-1）と2匹まとめての採点（R-2）

- 状態: 採用（係数は大半を0で採用。docs/sim-eval/README.md）
- 日付: 2026-11-28

## 背景

方針（`packages/sim/src/policy.ts`）はスロットごとの点数を足していたため、(1) 自分が動く前に倒されるケースを考えない、(2) 同じ相手への攻撃で撃破の加点が二重に入る・連携を評価しない、という問題があった。

## 決定

- 行動順は Showdown の `battle.getActionSpeed()`（優先度の補正＝いたずらごころ・グラススライダー等、素早さの補正＝おいかぜ・トリックルーム・まひ・こだわりスカーフ等）で得る（`actionOrder()`）。自前で計算しない。呼び出し中は PRNG を複製に差し替え、対戦の乱数を消費しない。
- 相手に自分を倒せる技があり、それが自分より先に動く確率を求め、攻撃の価値の割引（`outspedKoDiscount`）、守る・交代の加点（`outspedProtectBonus` / `outspedSwitchBonus`）に使う。先制技で倒せる見込みに `priorityKoBonus`。
- 2匹の行動は組み合わせごとに `jointScore()` で採点し、組み合わせ全体のソフトマックスで選ぶ（`chooseFor` / `policyDistribution` / `jointOptions` / `searchCandidates` で共通）。補正が0なら、各スロットを独立に選ぶ従来の確率と完全に一致する。
  - 同じ相手への与ダメージの合算と上限（`jointInteraction`、0〜1で強さ）、片方で倒せる相手への重複の減点（`overkillPenalty`）、2匹で初めて倒せる場合の加点（`focusKoBonus`）、倒せる見込みを0/1でなく幅で扱う（`koSpread`）。
  - 相棒が守るときは全体技の巻き込みの減点を戻す（`allyProtectRefund`）。このゆびとまれ等＋積み技／攻撃（`redirectSetupBonus` / `redirectAttackBonus`）。
- 係数は探索との一致（ADR-0011）で、全局面と2分割の両方で悪化しないものだけを採用した。現時点で採用したのは `outspedSwitchBonus = 0.1` だけ。ほかは仕組みを残して0。

## 影響

- 組み合わせ単位の抽選になったため、方針の乱数の消費が変わり、同じシードでも対戦の中身は以前と変わる（確率は同じ）。
- 計画の受け入れ条件（上から倒される側の守る／交代が増える、重複攻撃が減る、集中が増える）は、係数を入れたときに仕組みが働くことをテストで確認する（`packages/sim/test/policy.test.ts`）。パックの値では大半が0なので、その挙動は出ない。
- 実戦の記録がそろったら、`sim:eval` で同じ係数を測り直して見直す。
