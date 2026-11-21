#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { gameSpec, loadPack, PackValidationError } from "@ca/data";
import { FsPackSource, readTeamDbFiles, readUsageSnapshots } from "@ca/data/node";
import { metaCommand } from "./meta-commands.js";
import { runSimMeta, simCommand, simMetaCommand, type SimEnv } from "./sim-commands.js";
import { renderMetaReport } from "./report.js";
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
      const { chromium } = await import("playwright");
      const browser = await chromium.launch();
      const page = await browser.newPage({
        viewport: { width: 430, height: 900 },
        deviceScaleFactor: 2,
      });
      await page.goto(`file://${htmlPath}`);
      const png = resolvePath(outDir, `${name}-meta.png`);
      await page.screenshot({ path: png, fullPage: true });
      await browser.close();
      io.out(png);
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
