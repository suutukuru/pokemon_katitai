import { expect, test } from "@playwright/test";

test("party tab: members with real stats; copy-and-edit saves a new team on this device", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "パーティ" }).click();
  await page.getByLabel("自分のパーティ", { exact: true }).selectOption({ label: "team2" });
  await expect(page.locator(".member-head strong").first()).toHaveText("メガドリュウズ");
  await page.getByRole("button", { name: "コピーして改造" }).click();
  await page.getByLabel("パーティ名").fill("改造案テスト");
  await page.getByRole("button", { name: "保存して使う" }).click();
  await expect(page.getByLabel("自分のパーティ", { exact: true })).toHaveValue(/^saved:/);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("board: start a game, see evaluations, play a turn and go back", async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto("/");
  await page.getByRole("button", { name: "対戦盤" }).click();
  await page.getByLabel("自分のパーティ（対戦盤）").selectOption({ label: "team2" });
  await page.getByRole("button", { name: "この選出で開始" }).click();
  await expect(page.locator(".mon.me")).toHaveCount(2);
  await page.getByRole("button", { name: "速", exact: true }).click();
  // the first position is analysed automatically
  await expect(page.locator(".eval-num strong")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator(".opt").first()).toBeVisible();
  await page.locator("button.opt").nth(1).click();
  await page.getByRole("button", { name: "このターンを実行" }).click();
  await expect(page.getByText("直前のターン")).toBeVisible();
  await expect(page.locator(".events li").first()).toBeVisible();
  await page.getByRole("button", { name: "1手戻る" }).click();
  await expect(page.locator(".turn")).toHaveText("1ターン目");
});
