import type { Evidence } from "@ca/schema";
import type { FindingDraft, Rule } from "../rule.js";
import { clamp01 } from "../rule.js";

/** Needs a usage snapshot: how the team's best attack does into each top threat. */
export const threatOffenseRule: Rule = {
  id: "offense.threats",
  version: 1,
  category: "offense",
  params: ["topN", "twoHkoProb"],
  appliesTo: (ctx) => ctx.threats.length > 0,
  evaluate(ctx) {
    const topN = ctx.param(this.id, "topN");
    const need = ctx.param(this.id, "twoHkoProb");
    const findings: FindingDraft[] = [];
    let ok = 0;
    const threats = ctx.threats.slice(0, topN);
    for (const t of threats) {
      let best: { member: string; move: string; p2: number; max: number; pct: number } | undefined;
      for (const m of ctx.team) {
        for (const a of ctx.attackingMoves(m)) {
          const r = ctx.calc.damage(
            { set: m, mega: ctx.canMega(m) },
            { set: t.set, mega: t.mega },
            a.id,
          );
          // P(2HKO) without crits/accuracy: two independent rolls sum ≥ HP
          let p2 = 0;
          for (const x of r.distribution)
            for (const y of r.distribution)
              if (x.damage + y.damage >= r.defenderHp) p2 += x.p * y.p;
          if (!best || p2 > best.p2 || (p2 === best.p2 && r.max > best.max))
            best = { member: m.species, move: a.id, p2, max: r.max, pct: r.percent[1] };
        }
      }
      if (best && best.p2 >= need) ok++;
      else {
        findings.push({
          explainKey: "offense.threat.no2hko",
          score: best?.p2 ?? 0,
          params: {
            hits: 2,
            threat: t.species,
            usage: Math.round(t.usage * 1000) / 10,
            member: best?.member ?? "",
            move: best?.move ?? "",
            p2: Math.round((best?.p2 ?? 0) * 1000) / 10,
            pct: best?.pct ?? 0,
          },
          evidence: [
            {
              kind: "calc",
              label: "最もよく効く攻撃の2発で倒す確率（急所・命中なし）",
              values: {
                member: best?.member ?? "",
                move: best?.move ?? "",
                p2: best?.p2 ?? 0,
                maxPercent: best?.pct ?? 0,
              },
            },
            {
              kind: "data",
              label: "使用率",
              values: { species: t.species, usage: t.usage },
              source: ctx.usage!.source,
              snapshot: ctx.usage!.date,
            } as Evidence,
          ],
        });
      }
    }
    return { score: clamp01(ok / Math.max(1, threats.length)), findings };
  },
};

/** Needs a usage snapshot: which members are OHKO'd by a top threat's best move. */
export const threatDefenseRule: Rule = {
  id: "defense.threats",
  version: 1,
  category: "matchup",
  params: ["topN", "ohkoProb"],
  appliesTo: (ctx) => ctx.threats.length > 0,
  evaluate(ctx) {
    const topN = ctx.param(this.id, "topN");
    const limit = ctx.param(this.id, "ohkoProb");
    const findings: FindingDraft[] = [];
    let pairs = 0;
    let ohkos = 0;
    for (const t of ctx.threats.slice(0, topN)) {
      const victims: { member: string; move: string; p: number }[] = [];
      for (const m of ctx.team) {
        pairs++;
        let worst = { move: "", p: 0 };
        for (const a of ctx.attackingMoves(t.set)) {
          const r = ctx.calc.damage(
            { set: t.set, mega: t.mega },
            { set: m, mega: ctx.canMega(m) },
            a.id,
          );
          if (r.ohko.noCrit > worst.p) worst = { move: a.id, p: r.ohko.noCrit };
        }
        if (worst.p >= limit) {
          ohkos++;
          victims.push({ member: m.species, ...worst });
        }
      }
      if (victims.length >= Math.ceil(ctx.team.length / 2)) {
        findings.push({
          explainKey: "defense.threat.ohkoMany",
          score: clamp01(1 - victims.length / ctx.team.length),
          params: {
            threat: t.species,
            count: victims.length,
            total: ctx.team.length,
            victims: victims.map((v) => v.member).join(","),
          },
          evidence: [
            {
              kind: "calc",
              label: "1発で倒される確率（急所なし）",
              values: Object.fromEntries(victims.map((v) => [`${v.member}:${v.move}`, v.p])),
            },
            {
              kind: "data",
              label: "使用率",
              values: { species: t.species, usage: t.usage },
              source: ctx.usage!.source,
              snapshot: ctx.usage!.date,
            } as Evidence,
          ],
        });
      }
    }
    return { score: clamp01(1 - ohkos / Math.max(1, pairs)), findings };
  },
};
