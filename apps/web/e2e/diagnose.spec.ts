import { expect, test } from "@playwright/test";

// diagnosis lives in its own tab
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "診断" }).click();
});

const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };

test("sample teams → evidence-backed findings sorted by severity (phase 3 acceptance)", async ({
  page,
}) => {
  const samples = [
    ["チーム1（ユーザー提供）", "メガリザードンY"],
    ["サンプル：トリックルーム", "ブリムオン"],
    ["サンプル：あめ", "ペリッパー"],
  ] as const;
  for (const [sample, firstMember] of samples) {
    await page.getByLabel("サンプルのパーティ").selectOption({ label: sample });
    await page.getByRole("button", { name: "診断する" }).click();
    await expect(page.locator(".member-head strong").first()).toHaveText(firstMember);
    const findings = page.getByTestId("finding");
    await expect(findings.first()).toBeVisible();
    const severities = await findings.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-severity") ?? ""),
    );
    expect(severities.length).toBeGreaterThan(0);
    const ranks = severities.map((s) => SEVERITY_RANK[s]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // every finding exposes its evidence and is marked as computed
    for (const f of await findings.all()) {
      await expect(f.getByText(/根拠（\d+）/)).toBeVisible();
      await expect(f.getByText("✓ 計算結果")).toBeVisible();
    }
  }
});

test("the user's team: weather conflict with evidence, Mega stats shown", async ({ page }) => {
  await page.getByRole("button", { name: "診断する" }).click();
  const conflict = page.getByTestId("finding").filter({ hasText: "天気がぶつかる" });
  await expect(conflict).toContainText("カバルドンのすなおこし、リザードンのひでり");
  await conflict.getByText(/根拠/).click();
  await expect(conflict.getByText("[計算] 天気を変える特性・技")).toBeVisible();
  await expect(page.getByText("メガリザードンY")).toBeVisible();
  await expect(page.getByText("S 184(32)")).toBeVisible();
  await expect(page.getByText(/レギュレーション M-C/)).toBeVisible();
});

test("name typos are flagged for confirmation", async ({ page }) => {
  await page
    .getByLabel("パーティのテキスト（ポケペースト形式）")
    .fill("マスカーニヤ @ こだわりスカーフ\n特性: へんげんじざい\n- トリックフラワー\n- まもる");
  await page.getByRole("button", { name: "診断する" }).click();
  await expect(
    page.getByText("「マスカーニヤ」を「マスカーニャ」と読み替えました", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("⚠ 推測を含む")).toBeVisible();
});

test("no horizontal scroll at phone width", async ({ page }) => {
  await page.getByRole("button", { name: "診断する" }).click();
  await expect(page.getByTestId("finding").first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("save, export (copy) and delete use in-page controls only", async ({ page }) => {
  await page.getByLabel("保存するチーム名").fill("テスト");
  await page.getByRole("button", { name: "この端末に保存" }).click();
  await page.getByText("保存したチーム（1）").click();
  await page.getByRole("button", { name: "書き出し（JSONをコピー）" }).click();
  await expect(page.getByLabel("書き出したJSON")).toHaveValue(/"name": "テスト"/);
  await page.getByRole("button", { name: "すべて削除" }).click();
  await page.getByRole("button", { name: "本当にすべて削除する" }).click();
  await expect(page.getByText("保存したチーム（")).toHaveCount(0);
});
