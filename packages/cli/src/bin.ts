#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { gameSpec, loadPack, PackValidationError } from "@ca/data";
import { FsPackSource, readTeamDbFiles, readUsageSnapshots } from "@ca/data/node";
import { metaCommand } from "./meta-commands.js";
import { runSimMeta, simCommand, simMetaCommand, type SimEnv } from "./sim-commands.js";
import { renderMetaReport } from "./report.js";
import { renderBattleReport } from "./battle-report.js";
import {
  renderReplayBook,
  renderReplayPage,
  toArtifactPage,
  type ReplayBookEntry,
} from "./replay-report.js";
import { screenshotPages } from "./screenshot.js";
import { candidatePairs } from "./fill.js";
import { formatShowdown } from "@ca/ingest";
import {
  analyzeMatchup,
  budgetFrom,
  inProcessExecutor,
  mixSeed,
  simContext,
  simulate,
  traceBattle,
  analyzeReplay,
  searchBudgetFrom,
  type Config,
} from "@ca/sim";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { parseShowdown } from "@ca/ingest";
import { baseDex, dexWithNewSpecies, displayName, estimateTeam, queryTeams } from "@ca/data";
import {
  runBestPlayPool,
  workerDuels,
  workerPoolExecutor,
  workerRollouts,
  workerSimPool,
} from "@ca/sim/pool";
import { simReview, simTune } from "./learn.js";
import { teamBuild } from "./build.js";
import { pairBookCommand, teamPairs } from "./pairs.js";
import { teamBookCommand } from "./teambook.js";
import { selectCommand } from "./select.js";
import { webDataCommand } from "./web-data.js";
import { cpus } from "node:os";
import { calcCommand, teamCheck, type TeamEnv } from "./team-commands.js";
import { regDiff, regNew, regValidate, type Io } from "./commands.js";
import {
  buildI18n,
  importOfficial,
  importPokedbCommand,
  importSmogonCommand,
} from "./data-commands.js";

process.stdout.on("error", () => process.exit(0)); // e.g. piped into `head`
const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
const [cmd, ...args] = process.argv.slice(2);
const source = new FsPackSource(process.env["CA_REGULATIONS_DIR"]);
/** Default regulation for team commands; override with CA_REGULATION. */
const teamEnv = (): TeamEnv => ({
  pack: loadPack(source, process.env["CA_REGULATION"] ?? "M-C"),
  usage: readUsageSnapshots(process.env["CA_REGULATION"] ?? "M-C")[0],
  spec: gameSpec(),
  readText: (p) => readFileSync(p, "utf8"),
});

/** Team env + worker pool + "pokedb:M-7:4" opponents completed from the latest usage snapshot. */
function simEnv(args: string[]): SimEnv {
  const env = teamEnv();
  const wi = args.indexOf("--workers");
  const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
  const files = readTeamDbFiles();
  const usage = readUsageSnapshots(env.pack.id)[0];
  const dex = dexWithNewSpecies(baseDex(), env.pack.overrides.newSpecies);
  const seasons = env.pack.seasons;
  return {
    ...env,
    executor: (mine, theirs) =>
      workerPoolExecutor({ regulationId: env.pack.id, mine, theirs }, workers),
    resolveTeam: (spec) => {
      const m = /^pokedb:(M-\d+):(\d+)$/.exec(spec);
      if (!m || !usage) return undefined;
      const record = queryTeams(files).find(
        (t) => t.season === m[1] && t.rank === Number(m[2]) && t.format === "doubles",
      );
      if (!record) throw new Error(`${spec}: 上位構築データにありません`);
      const est = estimateTeam(record, usage, dex);
      const missing = est.missing.length
        ? `（推定できず: ${est.missing.map((x) => displayName("species", x)).join("・")}）`
        : "";
      return {
        members: est.sets,
        missing: est.missing,
        label: `${record.season} ${record.rank}位${record.rating ? ` レート${record.rating}` : ""}`,
        note: `ポケモンと持ち物は pokedb 公開データ、技・特性・性格・SP は ${usage.source.title} の最多の型で推定${missing}`,
      };
    },
    topTeams: (limit) =>
      queryTeams(files, {
        format: "doubles",
        ...(seasons ? { seasons: [seasons.from, seasons.to ?? 99] as [number, number] } : {}),
        legalSpecies: env.pack.legal.species,
      })
        .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
        .slice(0, limit)
        .map((t) => `pokedb:${t.season}:${t.rank}`),
  };
}

try {
  let code: number;
  switch (cmd) {
    case "reg:new":
      code = regNew(args, source, io, new Date().toISOString().slice(0, 10));
      break;
    case "reg:diff":
      code = regDiff(args, source, io);
      break;
    case "reg:validate":
      code = regValidate(args, source, io);
      break;
    case "data:import-official":
      code = importOfficial(args, io);
      break;
    case "data:import-smogon":
      code = importSmogonCommand(args, io);
      break;
    case "data:import-pokedb":
      code = importPokedbCommand(args, io);
      break;
    case "data:build-i18n":
      code = buildI18n(args, io);
      break;
    case "team:check":
      code = teamCheck(args, teamEnv(), io);
      break;
    case "sim":
    case "sim:meta": {
      const env = simEnv(args);
      code = cmd === "sim" ? await simCommand(args, env, io) : await simMetaCommand(args, env, io);
      break;
    }
    case "report:meta": {
      // `report:meta <自分.txt> [--top 10] [--scale 0.3] [--out reports]` → HTML + PNG (phone width)
      const env = simEnv(args);
      const file = args.find(
        (x, i) =>
          !x.startsWith("--") &&
          !["--top", "--scale", "--seed", "--workers", "--out"].includes(args[i - 1] ?? ""),
      );
      if (!file) {
        io.err(
          "usage: pnpm report:meta <自分のパーティ.txt> [--top 10] [--scale 0.3] [--out reports]",
        );
        code = 2;
        break;
      }
      const opt = (k: string, d: string) =>
        args.indexOf(`--${k}`) >= 0 ? args[args.indexOf(`--${k}`) + 1]! : d;
      const mine = parseShowdown(env.readText(file), {
        legal: { species: env.pack.legal.species, items: env.pack.legal.items },
      }).members;
      const rows = await runSimMeta(
        mine,
        env,
        {
          top: Number(opt("top", "10")),
          scale: Number(opt("scale", "0.3")),
          seed: Number(opt("seed", "1")),
        },
        io,
      );
      const name = basename(file).replace(/\.txt$/, "");
      const html = renderMetaReport({
        teamName: name,
        regulation: env.pack.id,
        mine: mine.map((m) => m.species),
        rows,
        date: new Date().toISOString().slice(0, 10),
        usageSource: env.usage?.source.title ?? "（使用率データなし）",
      });
      const outDir = resolvePath(opt("out", "reports"));
      mkdirSync(outDir, { recursive: true });
      const htmlPath = resolvePath(outDir, `${name}-meta.html`);
      writeFileSync(htmlPath, html);
      for (const png of await screenshotPages(htmlPath, resolvePath(outDir, `${name}-meta`)))
        io.out(png);
      code = 0;
      break;
    }
    case "report:battle": {
      // `report:battle <自分.txt> <相手.txt|pokedb:M-7:4> [--games 30] [--scale 0.3] [--seed 1] [--out reports]`
      const env = simEnv(args);
      const pos = args.filter(
        (x, i) =>
          !x.startsWith("--") &&
          !["--games", "--scale", "--seed", "--workers", "--out"].includes(args[i - 1] ?? ""),
      );
      const [mineFile, oppSpec] = pos;
      if (!mineFile || !oppSpec) {
        io.err(
          "usage: pnpm report:battle <自分.txt> <相手.txt|pokedb:M-7:4> [--games 30] [--scale 0.3]",
        );
        code = 2;
        break;
      }
      const opt = (k: string, d: string) =>
        args.indexOf(`--${k}`) >= 0 ? args[args.indexOf(`--${k}`) + 1]! : d;
      const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
      const mine = parseShowdown(env.readText(mineFile), legal).members;
      const resolved = env.resolveTeam?.(oppSpec);
      const theirs = resolved
        ? resolved.members
        : parseShowdown(env.readText(oppSpec), legal).members;
      const oppLabel = resolved?.label ?? basename(oppSpec).replace(/\.txt$/, "");
      const ctx = simContext(env.pack, env.spec);
      const seed = Number(opt("seed", "1"));
      const exec = env.executor!(mine, theirs);
      const a = await analyzeMatchup(
        ctx,
        mine,
        theirs,
        exec,
        budgetFrom(env.pack.weights.simulation, Number(opt("scale", "0.3"))),
        seed,
        (st) => io.err(`… ${st}`),
      );
      await (exec as { close?: () => Promise<void> }).close?.();
      const toConfig = (team: typeof mine, species: string[]) =>
        species.map((x) => team.findIndex((m) => m.species === x)) as Config;
      const ca = toConfig(
        mine,
        a.matrix.mine[a.equilibrium.mine.indexOf(Math.max(...a.equilibrium.mine))]!,
      );
      const cb = toConfig(
        theirs,
        a.matrix.theirs[a.equilibrium.theirs.indexOf(Math.max(...a.equilibrium.theirs))]!,
      );
      const games = Number(opt("games", "30"));
      const results = Array.from({ length: games }, (_, k) => ({
        k,
        r: simulate(ctx, mine, theirs, ca, cb, mixSeed(seed, 9, k)),
      }));
      const wins = results.filter((x) => x.r.winner === 0).length;
      const summary = `この選出同士で${games}戦: ${wins}勝${games - wins}敗（勝率 ${Math.round((wins / games) * 100)}%）`;
      const outDir = resolvePath(opt("out", "reports"));
      mkdirSync(outDir, { recursive: true });
      const name = basename(mineFile).replace(/\.txt$/, "");
      for (const [kind, pick] of [
        ["win", results.find((x) => x.r.winner === 0)],
        ["lose", results.find((x) => x.r.winner === 1)],
      ] as const) {
        if (!pick) continue;
        const log = traceBattle(ctx, mine, theirs, ca, cb, mixSeed(seed, 9, pick.k));
        const html = renderBattleReport({
          title: `${name} vs ${oppLabel}（${kind === "win" ? "勝ちの例" : "負けの例"}）`,
          log,
          summary,
          params: env.pack.weights.simulation,
        });
        const base = resolvePath(
          outDir,
          `${name}-vs-${oppLabel.replace(/[^\w.-]+/g, "_")}-${kind}`,
        );
        writeFileSync(`${base}.html`, html);
        for (const png of await screenshotPages(`${base}.html`, base)) io.out(png);
      }
      void inProcessExecutor;
      code = 0;
      break;
    }
    case "team:fill": {
      // `team:fill <下書き.txt> --candidates a,b,c [--top 6] [--scale 0.15]` → each pair vs top teams, ranked
      const env = simEnv(args);
      const opt = (k: string, d: string) =>
        args.indexOf(`--${k}`) >= 0 ? args[args.indexOf(`--${k}`) + 1]! : d;
      const file = args[0]!;
      const draft = parseShowdown(env.readText(file), {
        legal: { species: env.pack.legal.species, items: env.pack.legal.items },
      }).members;
      const dex = dexWithNewSpecies(baseDex(), env.pack.overrides.newSpecies);
      const pairs = candidatePairs(
        draft,
        opt("candidates", "").split(",").filter(Boolean),
        env.usage!,
        dex,
      );
      const outDir = resolvePath(
        opt("out", "reports"),
        basename(file).replace(/\.txt$/, "") + "-fill",
      );
      mkdirSync(outDir, { recursive: true });
      const ranking: {
        ids: string[];
        avg: number;
        worst: number;
        worstLabel: string;
        wins: number;
        n: number;
      }[] = [];
      for (const p of pairs) {
        const rows = await runSimMeta(
          p.team,
          env,
          { top: Number(opt("top", "6")), scale: Number(opt("scale", "0.15")), seed: 1 },
          io,
        );
        const avg = rows.reduce((a, r) => a + r.winRate, 0) / Math.max(1, rows.length);
        const worstRow = [...rows].sort((a, b) => a.winRate - b.winRate)[0];
        ranking.push({
          ids: p.ids,
          avg,
          worst: worstRow?.winRate ?? 0,
          worstLabel: worstRow?.label ?? "",
          wins: rows.filter((r) => r.winRate >= 0.5).length,
          n: rows.length,
        });
        writeFileSync(
          resolvePath(outDir, `${p.ids.join("+")}.txt`),
          formatShowdown(p.team, "ja") + "\n",
        );
        io.out(
          `${p.ids.map((x) => displayName("species", x)).join("+")}\t平均 ${Math.round(avg * 100)}%\t勝ち越し ${ranking.at(-1)!.wins}/${rows.length}\t最低 ${Math.round((worstRow?.winRate ?? 0) * 100)}% (${worstRow?.label ?? ""})`,
        );
      }
      writeFileSync(
        resolvePath(outDir, "ranking.json"),
        JSON.stringify(
          ranking.sort((a, b) => b.avg - a.avg),
          null,
          2,
        ),
      );
      code = 0;
      break;
    }
    case "team:pairs": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      const pool = workerSimPool(env.pack.id, workers);
      try {
        code = await teamPairs(
          args,
          env,
          {
            executor: (mine, theirs) => pool.executor(mine, theirs),
            dex: dexWithNewSpecies(baseDex(), env.pack.overrides.newSpecies),
          },
          io,
        );
      } finally {
        await pool.close();
      }
      break;
    }
    case "sim:select": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      code = await selectCommand(
        args,
        env,
        {
          executor: (mine, theirs) =>
            workerPoolExecutor({ regulationId: env.pack.id, mine, theirs }, workers),
          write: (path, text) => {
            mkdirSync(resolvePath(path, ".."), { recursive: true });
            writeFileSync(path, text);
          },
        },
        io,
      );
      break;
    }
    case "report:teambook": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      code = await teamBookCommand(
        args,
        env,
        {
          executor: (mine, theirs) =>
            workerPoolExecutor({ regulationId: env.pack.id, mine, theirs }, workers),
          play: (tasks, onDone) => {
            let done = 0;
            return runBestPlayPool(env.pack.id, tasks, workers, () => onDone(++done));
          },
          write: (path, text) => {
            mkdirSync(resolvePath(path, ".."), { recursive: true });
            writeFileSync(path, text);
          },
        },
        io,
      );
      break;
    }
    case "report:pairbook": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      code = await pairBookCommand(
        args,
        env,
        {
          dex: dexWithNewSpecies(baseDex(), env.pack.overrides.newSpecies),
          play: (tasks, onDone) => {
            let done = 0;
            return runBestPlayPool(env.pack.id, tasks, workers, () => onDone(++done));
          },
          write: (path, text) => {
            mkdirSync(resolvePath(path, ".."), { recursive: true });
            writeFileSync(path, text);
          },
        },
        io,
      );
      break;
    }
    case "team:build": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      const pool = workerSimPool(env.pack.id, workers);
      try {
        code = await teamBuild(
          args,
          env,
          {
            executor: (mine, theirs) => pool.executor(mine, theirs),
            dex: dexWithNewSpecies(baseDex(), env.pack.overrides.newSpecies),
            write: (path, text) => {
              mkdirSync(resolvePath(path, ".."), { recursive: true });
              writeFileSync(path, text);
              io.err(path);
            },
          },
          io,
        );
      } finally {
        await pool.close();
      }
      break;
    }
    case "sim:review": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      code = await simReview(
        args,
        env,
        {
          play: (tasks) =>
            runBestPlayPool(env.pack.id, tasks, workers, (i) =>
              io.err(`… ${i + 1}/${tasks.length}戦`),
            ),
          write: (path, json) => {
            mkdirSync(resolvePath(path, ".."), { recursive: true });
            writeFileSync(path, JSON.stringify(json, null, 1) + "\n");
            io.err(path);
          },
          writeWeights: (simulation) => {
            const path = resolvePath("packages/data/regulations", env.pack.id, "weights.json");
            const w = JSON.parse(readFileSync(path, "utf8")) as { simulation?: object };
            w.simulation = { ...w.simulation, ...simulation };
            writeFileSync(path, JSON.stringify(w, null, 2) + "\n");
          },
        },
        io,
      );
      break;
    }
    case "sim:tune": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      const pool = workerDuels(env.pack.id, workers);
      try {
        code = await simTune(
          args,
          env,
          {
            run: pool.run,
            writeWeights: (simulation) => {
              const path = resolvePath("packages/data/regulations", env.pack.id, "weights.json");
              const w = JSON.parse(readFileSync(path, "utf8")) as { simulation?: object };
              w.simulation = { ...w.simulation, ...simulation };
              writeFileSync(path, JSON.stringify(w, null, 2) + "\n");
            },
          },
          io,
        );
      } finally {
        await pool.close();
      }
      break;
    }
    case "web:data": {
      const env = simEnv(args);
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      const outDir = resolvePath(
        args.includes("--out") ? args[args.indexOf("--out") + 1]! : "apps/web/src/data",
      );
      code = await webDataCommand(
        args,
        env,
        {
          rollouts: (n) => workerRollouts(env.pack.id, n),
          write: (path, json) => {
            mkdirSync(resolvePath(path, ".."), { recursive: true });
            writeFileSync(path, JSON.stringify(json) + "\n");
          },
          outDir,
          workers,
        },
        io,
      );
      break;
    }
    case "report:book": {
      // `report:book <自分.txt> [--top 10] [--scale 0.3]` → one HTML: best-play battle vs each top team
      const env = simEnv(args);
      const opt = (k: string, d: string) =>
        args.indexOf(`--${k}`) >= 0 ? args[args.indexOf(`--${k}`) + 1]! : d;
      const mineFile = args.find(
        (x, i) =>
          !x.startsWith("--") &&
          !["--top", "--scale", "--seed", "--workers", "--out"].includes(args[i - 1] ?? ""),
      );
      if (!mineFile || !env.topTeams || !env.resolveTeam) {
        io.err("usage: pnpm report:book <自分のパーティ.txt> [--top 10] [--scale 0.3]");
        code = 2;
        break;
      }
      const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
      const mine = parseShowdown(env.readText(mineFile), legal).members;
      const ctx = simContext(env.pack, env.spec);
      const seed = Number(opt("seed", "1"));
      const budget = budgetFrom(env.pack.weights.simulation, Number(opt("scale", "1")));
      const prepared: {
        label: string;
        theirs: typeof mine;
        ca: Config;
        cb: Config;
        value: number;
      }[] = [];
      for (const spec of env.topTeams(Number(opt("top", "10")))) {
        const opp = env.resolveTeam(spec);
        if (!opp || opp.members.length < env.pack.rules.bringCount) continue;
        const exec = env.executor!(mine, opp.members);
        const a = await analyzeMatchup(ctx, mine, opp.members, exec, budget, seed);
        await (exec as { close?: () => Promise<void> }).close?.();
        const toConfig = (team: typeof mine, species: string[]) =>
          species.map((x) => team.findIndex((m) => m.species === x)) as Config;
        prepared.push({
          label: opp.label,
          theirs: opp.members,
          ca: toConfig(
            mine,
            a.matrix.mine[a.equilibrium.mine.indexOf(Math.max(...a.equilibrium.mine))]!,
          ),
          cb: toConfig(
            opp.members,
            a.matrix.theirs[a.equilibrium.theirs.indexOf(Math.max(...a.equilibrium.theirs))]!,
          ),
          value: a.equilibrium.value,
        });
        io.err(`… 選出決定: ${opp.label}`);
      }
      const search = searchBudgetFrom(env.pack.weights.simulation, Number(opt("think", "1")));
      const wi = args.indexOf("--workers");
      const datas = await runBestPlayPool(
        env.pack.id,
        prepared.map((x) => ({ mine, theirs: x.theirs, ca: x.ca, cb: x.cb, seed, budget: search })),
        wi >= 0 ? Number(args[wi + 1]) : 4,
        (i) => io.err(`… 最善手の対戦 完了: ${prepared[i]!.label}`),
      );
      const entries: ReplayBookEntry[] = prepared.map((x, i) => ({
        label: x.label,
        subtitle: `選出の読み合い（多数の対戦）での期待勝率 ${Math.round(x.value * 100)}%`,
        opponent: x.theirs.map((m) => m.species),
        data: datas[i]!,
      }));
      const name = basename(mineFile).replace(/\.txt$/, "");
      const wins = datas.filter((x) => x.result.winner === 0).length;
      const html = renderReplayBook({
        title: `${name} × M-C上位構築（最善手同士の対戦）`,
        subtitle: `${entries.length}構築と、両者が毎ターン勝率最大の行動を選ぶ対戦を1戦ずつ: ${wins}勝${entries.length - wins}敗 ／ 思考: 毎ターン両者の候補を絞り込み、上位${search.keep}×${search.keep}の組み合わせを各${search.matrixRollouts}〜${search.matrixRollouts + search.refineRollouts}戦して均衡（読み合いの最適な混ぜ方）を計算`,
        entries,
        params: env.pack.weights.simulation,
      });
      const outDir = resolvePath(opt("out", "reports"));
      mkdirSync(outDir, { recursive: true });
      const out = resolvePath(outDir, `${name}-book.html`);
      writeFileSync(out, html);
      // Artifact version (no doctype/head/body) for publishing as a browser page
      const artDir = resolvePath(outDir, "artifact");
      mkdirSync(artDir, { recursive: true });
      writeFileSync(
        resolvePath(artDir, `${name}-book.html`),
        toArtifactPage(html, "M-C 対戦ブック"),
      );
      io.out(out);
      code = 0;
      break;
    }
    case "report:replay": {
      // `report:replay <自分.txt> <相手|pokedb:M-7:4> [--pick lose|win] [--games 30] [--options 6] [--rollouts 16]`
      const env = simEnv(args);
      const pos = args.filter(
        (x, i) =>
          !x.startsWith("--") &&
          ![
            "--games",
            "--scale",
            "--seed",
            "--workers",
            "--out",
            "--pick",
            "--options",
            "--rollouts",
          ].includes(args[i - 1] ?? ""),
      );
      const [mineFile, oppSpec] = pos;
      if (!mineFile || !oppSpec) {
        io.err(
          "usage: pnpm report:replay <自分.txt> <相手.txt|pokedb:M-7:4> [--pick lose|win] [--rollouts 16]",
        );
        code = 2;
        break;
      }
      const opt = (k: string, d: string) =>
        args.indexOf(`--${k}`) >= 0 ? args[args.indexOf(`--${k}`) + 1]! : d;
      const legal = { legal: { species: env.pack.legal.species, items: env.pack.legal.items } };
      const mine = parseShowdown(env.readText(mineFile), legal).members;
      const resolved = env.resolveTeam?.(oppSpec);
      const theirs = resolved
        ? resolved.members
        : parseShowdown(env.readText(oppSpec), legal).members;
      const oppLabel = resolved?.label ?? basename(oppSpec).replace(/\.txt$/, "");
      const ctx = simContext(env.pack, env.spec);
      const seed = Number(opt("seed", "1"));
      const exec = env.executor!(mine, theirs);
      const a = await analyzeMatchup(
        ctx,
        mine,
        theirs,
        exec,
        budgetFrom(env.pack.weights.simulation, Number(opt("scale", "0.3"))),
        seed,
        (st) => io.err(`… ${st}`),
      );
      await (exec as { close?: () => Promise<void> }).close?.();
      const toConfig = (team: typeof mine, species: string[]) =>
        species.map((x) => team.findIndex((m) => m.species === x)) as Config;
      const ca = toConfig(
        mine,
        a.matrix.mine[a.equilibrium.mine.indexOf(Math.max(...a.equilibrium.mine))]!,
      );
      const cb = toConfig(
        theirs,
        a.matrix.theirs[a.equilibrium.theirs.indexOf(Math.max(...a.equilibrium.theirs))]!,
      );
      const games = Number(opt("games", "30"));
      const results = Array.from({ length: games }, (_, k) => ({
        k,
        r: simulate(ctx, mine, theirs, ca, cb, mixSeed(seed, 9, k)),
      }));
      const wins = results.filter((x) => x.r.winner === 0).length;
      const want = opt("pick", "lose") === "win" ? 0 : 1;
      const pick = results.find((x) => x.r.winner === want) ?? results[0]!;
      io.err(`… 分析中（${opt("rollouts", "16")}戦 × 選択肢 × ターン）`);
      const data = analyzeReplay(
        ctx,
        mine,
        theirs,
        ca,
        cb,
        mixSeed(seed, 9, pick.k),
        { options: Number(opt("options", "6")), rollouts: Number(opt("rollouts", "16")) },
        (t) => io.err(`… ${t}ターン目`),
      );
      const name = basename(mineFile).replace(/\.txt$/, "");
      const html = renderReplayPage({
        title: `${name} vs ${oppLabel}`,
        subtitle: `この選出同士で${games}戦: ${wins}勝${games - wins}敗（勝率 ${Math.round((wins / games) * 100)}%）の中の1戦 ／ シード ${pick.k}`,
        data,
        params: env.pack.weights.simulation,
      });
      const outDir = resolvePath(opt("out", "reports"));
      mkdirSync(outDir, { recursive: true });
      const out = resolvePath(
        outDir,
        `${name}-vs-${oppLabel.replace(/[^\w.-]+/g, "_")}-replay.html`,
      );
      writeFileSync(out, html);
      io.out(out);
      code = 0;
      break;
    }
    case "meta":
      code = metaCommand(
        args,
        readTeamDbFiles(),
        teamEnv().pack.legal.species,
        io,
        teamEnv().pack.seasons,
      );
      break;
    case "calc":
      code = calcCommand(args, teamEnv(), io);
      break;
    default:
      io.err(
        `unknown command: ${cmd ?? "(none)"}. commands: reg:new, reg:diff, reg:validate, data:import-official, data:build-i18n, team:check, calc`,
      );
      code = 2;
  }
  process.exitCode = code;
} catch (e) {
  io.err(e instanceof PackValidationError || e instanceof Error ? e.message : String(e));
  if (process.env["CA_DEBUG"] && e instanceof Error) io.err(e.stack ?? "");
  process.exitCode = 1;
}
