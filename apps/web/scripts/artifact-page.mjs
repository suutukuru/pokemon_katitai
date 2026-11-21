/* global URL, console */
// Build a claude.ai Artifact page from dist/: the host adds <!doctype>/<head>/<body>,
// so emit only title/meta, the stylesheet, the root element and the module script.
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const js = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
const css = /href="\.\/(assets\/[^"]+\.css)"/.exec(html)?.[1];
if (!js || !css) throw new Error("dist/index.html: assets not found");
const page = `<title>Champions Analyzer</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${css}">
<div id="root"></div>
<script type="module" src="${js}"></script>
`;
writeFileSync(new URL("../dist/artifact.html", import.meta.url), page);
console.log(JSON.stringify({ page: "dist/artifact.html", js, css }));
