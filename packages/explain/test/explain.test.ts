import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FindingSchema, type Finding } from "@ca/schema";
import {
  allowedNumbers,
  explainFinding,
  renderTemplate,
  TEMPLATES_JA,
  validateLlmText,
} from "../src/index.js";

const finding = (explainKey: string, params: Finding["params"]): Finding =>
  FindingSchema.parse({
    ruleId: "x",
    ruleVersion: 1,
    category: "speedControl",
    severity: "major",
    basis: "computed",
    score: 0.4,
    explainKey,
    params,
    evidence: [{ kind: "calc", label: "test", values: { speed: 152, charizard: 1 } }],
  });

describe("renderTemplate", () => {
  it("renders names, types, stats and pairs in Japanese", () => {
    expect(
      renderTemplate("{a:species}/{b:moves}/{c:types}/{d:stat}/{e:pairs}/{f:weather}/{g}", {
        a: "charizard,milotic",
        b: "tailwind",
        c: "Ice",
        d: "atk,hp",
        e: "charizard:Rock",
        f: "Sun",
        g: 3,
      }),
    ).toBe("リザードン、ミロカロス/おいかぜ/こおり/こうげき、HP/リザードン（いわ）/はれ/3");
    expect(() => renderTemplate("{missing}", {})).toThrow(/missing/);
  });
  it("explains a finding with labels and evidence lines", () => {
    const e = explainFinding(
      finding("speed.nearTier", {
        member: "charizard",
        speed: 152,
        add: 2,
        newSpeed: 154,
        passedCount: 3,
        examples: "garchomp",
        free: 0,
        donors: "hp",
      }),
    );
    expect(e).toMatchObject({
      severityLabel: "重要",
      category: "すばやさ",
      basisLabel: "計算結果",
      title: "すばやさがあと少しで届かない",
    });
    expect(e.body).toContain("リザードンのすばやさは152");
    expect(e.evidence[0]!.lines).toEqual(["speed: 152", "リザードン: 1"]);
    const w = explainFinding({
      ...finding("field.conflict.weather", { kinds: "Sand,Sun", setters: "hippowdon:sandstream" }),
      evidence: [
        {
          kind: "calc",
          label: "x",
          values: {
            Sand: "hippowdon:sandstream",
            users: "charizard,milotic",
            moves: "tailwind",
            n: true,
          },
        },
      ],
    });
    expect(w.evidence[0]!.lines).toEqual([
      "すなあらし: カバルドン（すなおこし）",
      "users: リザードン、ミロカロス",
      "moves: おいかぜ",
      "n: true",
    ]);
    expect(() => explainFinding(finding("nope", {}))).toThrow(/no template/);
  });
});

describe("templates never invent numbers", () => {
  it("property: every number in a rendered body comes from params", () => {
    const keys = Object.keys(TEMPLATES_JA);
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.integer({ min: 100, max: 999 }), (key, n) => {
        const t = TEMPLATES_JA[key]!;
        const params: Record<string, number | string> = {};
        for (const m of t.body.matchAll(/\{(\w+)(?::(\w+))?\}/g)) {
          params[m[1]!] =
            m[2] === "pairs"
              ? "charizard:Rock"
              : m[2] === "setters"
                ? "charizard:drought"
                : m[2] === "types"
                  ? "Ice"
                  : m[2] === "stat"
                    ? "spe"
                    : m[2]
                      ? "charizard"
                      : n;
        }
        const f = finding(key, params);
        expect(validateLlmText(explainFinding(f).body, f)).toBeDefined();
      }),
    );
  });
});

describe("LLM output guard", () => {
  const f = finding("speed.nearTier", {
    member: "charizard",
    speed: 152,
    add: 2,
    newSpeed: 154,
    passedCount: 3,
    examples: "garchomp",
    free: 0,
    donors: "hp",
  });
  it("accepts text using only engine numbers (incl. full-width digits)", () => {
    expect(validateLlmText("リザードンは152、２振れば154", f)).toBeDefined();
    expect(allowedNumbers(f).has("152")).toBe(true);
  });
  it("allows the fixed wording of the template", () => {
    const q = finding("defense.quadWeakness", { list: "charizard:Rock" });
    expect(validateLlmText("リザードンはいわが4倍弱点", q)).toBeDefined();
    expect(validateLlmText("リザードンはいわが4倍弱点で、確定3発", q)).toBeUndefined();
  });
  it("rejects text with invented numbers", () => {
    expect(validateLlmText("リザードンは確定2発、勝率73%", f)).toBeUndefined();
  });
});
