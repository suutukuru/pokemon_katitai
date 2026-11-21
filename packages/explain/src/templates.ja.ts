/**
 * Japanese templates. `{name}` inserts a param as-is; `{name:species}` / `:moves` / `:items` /
 * `:abilities` / `:types` render comma-separated IDs with localized names; `:stat` / `:weather` too.
 * Templates must not introduce numbers that are not in params (checked by tests).
 */
export const TEMPLATES_JA: Record<string, { title: string; body: string }> = {
  "legality.teamSize": { title: "人数オーバー", body: "チームが{count}体います（最大{max}体）。" },
  "legality.species": {
    title: "使用できないポケモン",
    body: "{member:species}（{slot}番目）はこのレギュレーションでは使えません。",
  },
  "legality.item": {
    title: "使用できない持ち物",
    body: "{member:species}の{item:items}はこのレギュレーションでは使えません。",
  },
  "legality.move": { title: "禁止技", body: "{member:species}の{move:moves}は禁止されています。" },
  "legality.ability": {
    title: "禁止特性",
    body: "{member:species}の{ability:abilities}は禁止されています。",
  },
  "legality.sp": {
    title: "SPの振りすぎ",
    body: "{member:species}：SP合計{total}（上限{cap}、1つのステータスは{perStat}まで）。",
  },
  "legality.speciesClause": {
    title: "同じポケモンが複数",
    body: "{member:species}が複数います（同じポケモンは1チームに1匹まで）。",
  },
  "legality.itemClause": {
    title: "同じ持ち物が複数",
    body: "{item:items}を複数のポケモンが持っています（同じ持ち物は1つまで）。",
  },

  "speedControl.none": {
    title: "すばやさ操作がない",
    body: "おいかぜ・トリックルーム・こごえるかぜ等のすばやさ操作を持つポケモンがいません。相手に先手を取られ続ける展開を変えられません。",
  },
  "speedControl.weakOnly": {
    title: "すばやさ操作が弱い",
    body: "すばやさ操作が{moves:moves}だけです。おいかぜ・トリックルームのような場全体を変える手段がありません。",
  },
  "speed.nearTier": {
    title: "すばやさがあと少しで届かない",
    body: "{member:species}のすばやさは{speed}です。すばやさのSPをあと{add}増やすと{newSpeed}になり、参加可能ポケモンの最速{passedCount}匹（{examples:species}など）を抜けます。",
  },
  "speed.suggest.free": {
    title: "すばやさSPを追加",
    body: "{member:species}：余っているSPからすばやさに{add}振ると{newSpeed}（最速{passedCount}匹を新たに抜く）。",
  },
  "speed.suggest.move": {
    title: "すばやさSPを移す",
    body: "{member:species}：{donors:stat}から{add}をすばやさに移すと{newSpeed}（最速{passedCount}匹を新たに抜く）。移した分の耐久・火力の低下は要確認。",
  },

  "support.fakeout.missing": {
    title: "ねこだましがない",
    body: "ねこだましを持つポケモンがいません。1ターン目に相手の行動を止める手段が減ります。",
  },
  "support.intimidate.missing": {
    title: "いかくがない",
    body: "いかく持ちがいません。相手の物理アタッカーへの受けが重くなります。",
  },
  "support.redirection.missing": {
    title: "このゆびとまれ系がない",
    body: "このゆびとまれ・いかりのこなを持つポケモンがいません（必須ではありません）。",
  },
  "support.protect.few": {
    title: "まもるが少ない",
    body: "まもる系の技を持つのが{count}匹です（目安{min}匹以上）。持っていない：{without:species}。",
  },

  "defense.sharedWeakness": {
    title: "弱点が重なっている",
    body: "{type:types}技が{weakCount}匹（{weak:species}）に抜群で、半減以下は{resistCount}匹だけです。",
  },
  "defense.quadWeakness": { title: "4倍弱点", body: "4倍弱点：{list:pairs}。" },
  "offense.coverage.legal": {
    title: "抜群を取れない相手がいる",
    body: "参加可能な{total}匹のうち{count}匹に、どの技でも抜群を取れません（例：{examples:species}）。タイプ相性だけで判定しています。",
  },
  "offense.coverage.threats": {
    title: "上位の相手に抜群を取れない",
    body: "使用率上位{total}匹のうち{count}匹に、どの技でも抜群を取れません（例：{examples:species}）。",
  },

  "mega.none": {
    title: "メガシンカなし",
    body: "メガストーンを持つポケモンがいません（1試合に{perBattle}回メガシンカできます）。",
  },
  "mega.tooMany": {
    title: "メガ枠が多い",
    body: "メガストーン持ちが{count}匹（{holders:species}）います。1試合でメガシンカできるのは{perBattle}匹なので、選出が縛られます。",
  },

  "field.conflict.weather": {
    title: "天気がぶつかる",
    body: "同じチームに違う天気を起こすものがあります：{setters:setters}。後から出た方の天気に上書きされます。",
  },
  "field.conflict.terrain": {
    title: "フィールドがぶつかる",
    body: "同じチームに違うフィールドを張るものがあります：{setters:setters}。",
  },

  "selection.inflexible": {
    title: "選出の自由度が低い",
    body: "選出の全{total}通りのうち、すばやさ操作とまもるが揃うのは{good}通りです。",
  },
  "selection.essential": {
    title: "外せないポケモンがいる",
    body: "成立する選出{good}通りのすべてに{essential:species}が入っています。このポケモンが通らない相手には選出が崩れます。",
  },

  "matchup.trickRoom.noAnswer": {
    title: "トリックルームへの対策がない",
    body: "相手のトリックルームを止める・逆用する手段（トリックルーム、ちょうはつ、ねこだまし、すばやさ{slowSpeed}以下のポケモン）がありません。",
  },
  "offense.threat.no2hko": {
    title: "上位の相手を確定2発にできない",
    body: "{threat:species}（使用率{usage}%）を{hits}発で倒せる確率は、最も効く{member:species}の{move:moves}でも{p2}%です（1発の最大{pct}%）。",
  },
  "defense.threat.ohkoMany": {
    title: "1匹に半分以上が一撃で倒される",
    body: "{threat:species}の攻撃で、{total}匹中{count}匹（{victims:species}）が1発で倒されます。",
  },
};

export const SEVERITY_JA = {
  critical: "致命的",
  major: "重要",
  minor: "注意",
  info: "参考",
} as const;
export const BASIS_JA = { computed: "計算結果", estimated: "推測を含む" } as const;
export const CATEGORY_JA: Record<string, string> = {
  legality: "ルール違反",
  speedControl: "すばやさ",
  support: "補助",
  defensiveSynergy: "耐性",
  offense: "攻撃",
  matchup: "相性",
  itemAbility: "持ち物・特性",
  selection: "選出",
  mega: "メガシンカ",
  field: "天気・フィールド",
};
