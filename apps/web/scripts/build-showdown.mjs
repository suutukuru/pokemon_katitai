/* global console, process, URL */
// Bundle pokemon-showdown (MIT) for the browser: the simulator loads its data with dynamic
// `require(path)` and `fs.readdirSync`, so those calls are rewritten to a static table that only
// holds what the Champions formats need (base data + the champions mod, no learnsets/text).
// Output: apps/web/src/gen/showdown.js (ESM, default export = the CommonJS module object).
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";

const require = createRequire(new URL("../../../packages/sim/package.json", import.meta.url));
const psRoot = dirname(require.resolve("pokemon-showdown/package.json"));
const dist = join(psRoot, "dist");
const out = new URL("../src/gen/showdown.js", import.meta.url).pathname;
mkdirSync(dirname(out), { recursive: true });

const MODS = ["champions", "championsregma"];
const FILES = [
  "abilities",
  "rulesets",
  "formats-data",
  "items",
  "moves",
  "natures",
  "pokedex",
  "scripts",
  "conditions",
  "typechart",
];
const table = [];
const add = (virtual, file) => {
  if (existsSync(file)) table.push([virtual, file]);
};
for (const f of FILES) add(`/ps/data/${f}`, join(dist, "data", `${f}.js`));
for (const m of MODS)
  for (const f of FILES) add(`/ps/data/mods/${m}/${f}`, join(dist, "data/mods", m, `${f}.js`));
add("/ps/data/aliases", join(dist, "data/aliases.js"));
add("/ps/config/formats", join(dist, "config/formats.js"));

const tableSrc = `
const T = {
${table.map(([k, f]) => `  ${JSON.stringify(k)}: () => require(${JSON.stringify("./" + relative(dist, f).replace(/\\/g, "/"))}),`).join("\n")}
};
function norm(p) {
  const parts = [];
  for (const s of String(p).replace(/\\.js$/, "").split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") parts.pop(); else parts.push(s);
  }
  return "/" + parts.join("/");
}
globalThis.__psRequire = (p) => {
  const f = T[norm(p)];
  if (norm(p).startsWith("/ps/data/text/")) return new Proxy({}, { get: () => ({}) }); // descriptions only
  if (!f) { const e = new Error("not bundled: " + p); e.code = "MODULE_NOT_FOUND"; throw e; }
  return f();
};
module.exports = { Battle: require("./sim/battle.js").Battle, Dex: require("./sim/dex.js").Dex };
`;

const shim = {
  name: "ps-browser",
  setup(b) {
    b.onResolve({ filter: /^(fs|node:fs)$/ }, () => ({ path: "fs", namespace: "shim" }));
    b.onResolve({ filter: /^(path|node:path)$/ }, () => ({ path: "path", namespace: "shim" }));
    b.onResolve(
      {
        filter:
          /[\\/]lib[\\/](process-manager|sql|repl|fs|net|streams)(\.js)?$|^\.\.?\/(lib\/)?(process-manager|sql|repl|fs|net)$/,
      },
      () => ({ path: "empty", namespace: "shim" }),
    );
    b.onResolve({ filter: /^(node:util|util|node:crypto|crypto)$/ }, () => ({
      path: "empty",
      namespace: "shim",
    }));
    b.onLoad({ filter: /.*/, namespace: "shim" }, (a) => ({
      loader: "js",
      contents:
        a.path === "fs"
          ? `module.exports = { readdirSync: () => ${JSON.stringify(readdirSync(join(dist, "data/mods")))}, existsSync: () => false };`
          : a.path === "path"
            ? `const norm = (p) => { const o = []; for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") o.pop(); else o.push(s); } return "/" + o.join("/"); };
module.exports = { resolve: (...xs) => norm(xs.reduce((a, x) => (x.startsWith("/") ? x : a + "/" + x), "")), join: (...xs) => norm(xs.join("/")), sep: "/" };`
            : `const eq = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && eq(a[k], b[k]));
};
module.exports = { inspect: { custom: Symbol("inspect") }, isDeepStrictEqual: eq };`,
    }));
    b.onLoad({ filter: /[\\/]dist[\\/]sim[\\/](dex|dex-formats|teams)\.js$/ }, (a) => {
      let src = readFileSync(a.path, "utf8");
      // dynamic paths (and the random-team generators, which we never use) go to the table
      src = src
        .replace(/(?<![\w.])require\((?!")/g, "globalThis.__psRequire(")
        .replace(
          /(?<![\w.])require\((?="\.\.\/data\/(mods|random-battles)\/)/g,
          "globalThis.__psRequire(",
        )
        .replace(/(?<![\w.])require\((?="node:)/g, "globalThis.__psRequire(");
      return { contents: src, loader: "js" };
    });
  },
};

const t0 = Date.now();
await build({
  stdin: { contents: tableSrc, resolveDir: dist, sourcefile: "ps-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: process.env.PS_MINIFY !== "0",
  // Battle.toJSON/fromJSON (State) identifies objects by their class names
  keepNames: true,
  legalComments: "eof",
  define: { __dirname: '"/ps/sim"', "process.env.NODE_ENV": '"production"' },
  outfile: out,
  plugins: [shim],
  logLevel: "warning",
});
// esbuild's ESM output of a CJS entry exposes it as the default export.
console.log(
  `showdown bundle → ${relative(process.cwd(), out)} (${Math.round(readFileSync(out).length / 1024)}KB, ${Date.now() - t0}ms)`,
);
