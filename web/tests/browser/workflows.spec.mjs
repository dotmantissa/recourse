import { test, expect } from "@playwright/test";

test("disclosure, nested fee cancellation, keyboard focus, and retry preserve the form", async ({ page }) => {
  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Fund a request" });
  await trigger.click();
  const purchase = page.getByRole("dialog", { name: "Fund Independent service" });
  const fund = purchase.getByRole("button", { name: "Fund and run" });
  await expect(fund).toBeDisabled();
  await purchase.getByLabel("Request label", { exact: true }).fill("Preserve this request");
  await purchase.getByRole("checkbox").check();
  await fund.click();
  const approval = page.getByRole("dialog", { name: "Review the fee budget" });
  await expect(approval).toBeVisible();
  for (let count = 0; count < 8; count += 1) {
    await page.keyboard.press("Tab");
    await expect.poll(() => approval.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(approval).toHaveCount(0);
  await expect(purchase).toBeVisible();
  await expect(purchase.getByLabel("Request label", { exact: true })).toHaveValue("Preserve this request");
  await expect(fund).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem("fixture-submissions"))).toBeNull();
  await page.keyboard.press("Escape");
  await expect(purchase).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("unknown finality survives reload and resumes without another submission", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Fund a request" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Fund and run" }).click();
  await page.getByRole("button", { name: "Approve budget and open wallet" }).click();
  await expect(page.getByRole("alert")).toContainText("Its ID is saved");
  await page.reload();
  await page.getByRole("button", { name: "Check finality (no new transaction)" }).click();
  await expect(page.getByRole("button", { name: "Check finality (no new transaction)" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("fixture-submissions"))).toBe("1");
});

test("provider controls and history do not imply verified trust", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Provider settlement history", { exact: true }).first().click();
  await expect(page.getByText("Unrated — no settled jobs.")).toBeVisible();
  await expect(page.getByText(/self-dealing and new addresses/)).toBeVisible();
  await page.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(page.getByRole("button", { name: "Withdraw available" })).toBeVisible();
  await page.getByRole("button", { name: "Pause new jobs" }).click();
  await expect(page.getByRole("dialog", { name: "Review the fee budget" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Owned service", exact: true })).toBeVisible();
});

test("RPC and history failures are announced without fabricated results", async ({ page }) => {
  await page.goto("/?offline");
  await expect(page.getByRole("alert")).toContainText("RPC unavailable");
  await page.goto("/?history-offline");
  await page.getByText("Provider settlement history", { exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("No trust score is inferred");
});
