#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { gameSpec, loadPack, PackValidationError } from "@ca/data";
import { FsPackSource, readTeamDbFiles, readUsageSnapshots } from "@ca/data/node";
import { metaCommand } from "./meta-commands.js";
import { runSimMeta, simCommand, simMetaCommand, type SimEnv } from "./sim-commands.js";
import { renderMetaReport } from "./report.js";
import { renderBattleReport } from "./battle-report.js";
import { screenshotPages } from "./screenshot.js";
import {
  analyzeMatchup,
  budgetFrom,
  inProcessExecutor,
  mixSeed,
  simContext,
  simulate,
  traceBattle,
  type Config,
} from "@ca/sim";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { parseShowdown } from "@ca/ingest";
import { baseDex, dexWithNewSpecies, displayName, estimateTeam, queryTeams } from "@ca/data";
import { workerPoolExecutor } from "@ca/sim/pool";
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
  process.exitCode = 1;
}
