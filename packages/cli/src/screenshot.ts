// Node-only: render a report HTML to phone-sized PNG pages, split between top-level blocks.
export async function screenshotPages(
  htmlPath: string,
  outBase: string,
  maxCssHeight = 1500,
): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 430, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.goto(`file://${htmlPath}`);
    const boxes = await page.$$eval("main > *", (els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
      }),
    );
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    // group consecutive blocks so each page stays under maxCssHeight (a single taller block gets its own page)
    const pages: { y: number; h: number }[] = [];
    let start = 0;
    let end = 0;
    for (const b of boxes) {
      if (b.bottom - start > maxCssHeight && end > start) {
        pages.push({ y: start, h: end - start + 8 });
        start = b.top - 8;
      }
      end = b.bottom;
    }
    pages.push({ y: start, h: Math.max(end, total) - start });
    const out: string[] = [];
    for (const [i, p] of pages.entries()) {
      const path = pages.length === 1 ? `${outBase}.png` : `${outBase}-${i + 1}.png`;
      await page.screenshot({
        path,
        fullPage: true,
        clip: { x: 0, y: Math.max(0, p.y), width: 430, height: p.h },
      });
      out.push(path);
    }
    return out;
  } finally {
    await browser.close();
  }
}
