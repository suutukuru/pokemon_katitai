# 実戦の対戦記録（方針の検証用）

`pnpm sim:eval records/` で、シミュレーションの行動方針（`packages/sim/src/policy.ts`）が実戦の行動をどれだけ当てるかを測ります（R-0）。
ここに置くのは**自分で手入力した記録**か、**自分で保存した Showdown のリプレイログ**だけです（自動収集はしない。OPEN_QUESTIONS D-02）。

形式は `@ca/schema` の `BattleRecordSchema`（`packages/schema/src/battle-record.ts`）。1ファイル1戦の JSON。

## Showdown のリプレイログから

リプレイページの「Download」で保存した HTML の中の `<script type="text/plain" class="battle-log-data">` の中身（`|` で始まる行）を `showdownLog` に貼ります。
両者のパーティ（6匹、技構成込み）はログに無いので `teams` に貼り付けテキストで書きます。`turns` と `brought` はログから作られます（`brought` はログに出てこなかった控えを補うときだけ書く。先頭2匹がログの先発と同じなら採用）。

```json
{
  "id": "2026-11-28-ladder-1",
  "regulationId": "M-C",
  "source": "showdown-log",
  "teams": ["Charizard @ Charizardite Y\nAbility: Blaze\n...", "Pelipper @ Focus Sash\n..."],
  "brought": [
    ["charizard", "whimsicott"],
    ["pelipper", "archaludon"]
  ],
  "showdownLog": "|player|p1|...\n|switch|p1a: Charizard|Charizard, L50, M|100/100\n...\n|turn|1\n..."
}
```

## 手入力

```json
{
  "id": "2026-11-28-wifi-1",
  "regulationId": "M-C",
  "source": "manual",
  "teams": ["（自分のパーティ）", "（相手のパーティ。分かる範囲で）"],
  "brought": [
    ["charizard", "whimsicott", "meowscarada", "aerodactyl"],
    ["pelipper", "archaludon", "rillaboom", "basculegion"]
  ],
  "winner": 0,
  "turns": [
    {
      "turn": 1,
      "state": [
        [
          { "species": "charizard", "hpPct": 100 },
          { "species": "whimsicott", "hpPct": 100 }
        ],
        [
          { "species": "pelipper", "hpPct": 100 },
          { "species": "archaludon", "hpPct": 100 }
        ]
      ],
      "actions": [
        [{ "move": "heatwave", "mega": true }, { "move": "tailwind" }],
        [{ "move": "hurricane", "target": "whimsicott" }, { "move": "protect" }]
      ]
    },
    {
      "turn": 2,
      "state": [
        [
          { "species": "charizard", "hpPct": 64 },
          { "species": "whimsicott", "hpPct": 30, "status": "par" }
        ],
        [
          { "species": "pelipper", "hpPct": 0.1 },
          { "species": "archaludon", "hpPct": 81, "boosts": { "spa": 1 } }
        ]
      ],
      "actions": [
        [{ "switch": "meowscarada" }, { "move": "moonblast", "target": "archaludon" }],
        [{ "unknown": true }, { "move": "electroshot", "target": "charizard" }]
      ],
      "replacements": [["aerodactyl"], []]
    }
  ]
}
```

- `state` の各側は、そのターン開始時に場にいるポケモンを位置の順に（倒れて空いた位置は詰める）。`actions` も同じ順。
- 行動が分からない（ひるみ・ねむり・先に倒れた）ときは `{ "unknown": true }`。
- `replacements` はそのターンの終わりに倒れた後に出したポケモン。

## 基準値と比較

```sh
pnpm sim:eval records/ --json > docs/sim-eval/baseline.json        # 現行方針の基準値
pnpm sim:eval records/ --baseline docs/sim-eval/baseline.json      # 修正後に前後比較
```

選出の評価（実際の4匹・先発が推奨の何位か）は両者6匹の記録でだけ行い、`analyzeMatchup` を回すので時間がかかります（`--scale` で調整、`--no-selection` で省略）。
