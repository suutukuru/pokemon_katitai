// `tsx packages/cli/src/rebook.ts <book.html> <out.html>`: re-render a saved book with the current
// viewer and emit the Artifact (browser page) version.
import { readFileSync, writeFileSync } from "node:fs";
import { renderReplayBook, toArtifactPage } from "./replay-report.js";

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error("usage: rebook <book.html> <out.html>");
const html = readFileSync(src, "utf8");
const payload = JSON.parse(
  /<script id="payload" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!,
);
const title = /<h1>([\s\S]*?)<\/h1>/.exec(html)![1]!.replace(/&amp;/g, "&");
const subtitle = /<p class="sub">([\s\S]*?)<\/p>/.exec(html)![1]!.replace(/&amp;/g, "&");
const page = renderReplayBook({
  title,
  subtitle,
  params: payload.p,
  entries: payload.books.map(
    (b: { label: string; subtitle: string; opponent: string[]; d: unknown }) => ({
      label: b.label,
      subtitle: b.subtitle,
      opponent: b.opponent,
      data: b.d,
    }),
  ),
});
writeFileSync(out, toArtifactPage(page, "M-C 対戦ブック"));
console.log(out, Math.round(page.length / 1024) + "KB");
