#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { gameSpec, loadPack, PackValidationError } from "@ca/data";
import { FsPackSource, readTeamDbFiles } from "@ca/data/node";
import { metaCommand } from "./meta-commands.js";
import { simCommand } from "./sim-commands.js";
import { workerPoolExecutor } from "@ca/sim/pool";
import { cpus } from "node:os";
import { calcCommand, teamCheck, type TeamEnv } from "./team-commands.js";
import { regDiff, regNew, regValidate, type Io } from "./commands.js";
import { buildI18n, importOfficial, importPokedbCommand } from "./data-commands.js";

process.stdout.on("error", () => process.exit(0)); // e.g. piped into `head`
const io: Io = { out: (l) => console.log(l), err: (l) => console.error(l) };
const [cmd, ...args] = process.argv.slice(2);
const source = new FsPackSource(process.env["CA_REGULATIONS_DIR"]);
/** Default regulation for team commands; override with CA_REGULATION. */
const teamEnv = (): TeamEnv => ({
  pack: loadPack(source, process.env["CA_REGULATION"] ?? "M-C"),
  spec: gameSpec(),
  readText: (p) => readFileSync(p, "utf8"),
});

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
    case "data:import-pokedb":
      code = importPokedbCommand(args, io);
      break;
    case "data:build-i18n":
      code = buildI18n(args, io);
      break;
    case "team:check":
      code = teamCheck(args, teamEnv(), io);
      break;
    case "sim": {
      const env = teamEnv();
      const wi = args.indexOf("--workers");
      const workers = wi >= 0 ? Number(args[wi + 1]) : Math.max(1, cpus().length);
      code = await simCommand(
        args,
        {
          ...env,
          executor: (mine, theirs) =>
            workerPoolExecutor({ regulationId: env.pack.id, mine, theirs }, workers),
        },
        io,
      );
      break;
    }
    case "meta":
      code = metaCommand(args, readTeamDbFiles(), teamEnv().pack.legal.species, io);
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
