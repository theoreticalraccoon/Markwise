import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const site = process.env.MARKWISE_TEST_ORIGIN || "https://markwise-sl.vercel.app";
if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const email = `markwise-fresh-ui-${Date.now()}@example.com`;
const password = "markwise-test-1234";
const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createError) throw createError;
let browser;

try {
  const id = created.user.id;
  const profile = await admin.from("profiles").insert({
    id, subjects: ["E-4MA1"], onboarded: true, prefs: {}, display_name: "Fresh test",
  });
  if (profile.error) throw profile.error;
  const task = await admin.from("tasks").insert({ user_id: id, subject: "E-4MA1", text: "Reset test" });
  if (task.error) throw task.error;

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(site, { waitUntil: "domcontentloaded" });
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(password);
  await page.locator("#authSubmit").click();
  await page.locator("[data-nav=settings]").first().click();
  await page.locator("#eraseData").waitFor();

  await page.locator("#eraseData").click();
  await page.locator("#eraseConfirm").fill("delete");
  assert.equal(await page.locator("#eraseGo").isDisabled(), true);
  await page.locator("[data-modal-close]").first().click();
  assert.equal(await page.locator("#eraseGo").count(), 0);
  assert.equal((await admin.from("tasks").select("id").eq("user_id", id)).data.length, 1);

  await page.locator("#eraseData").click();
  await page.locator("#eraseConfirm").fill("DELETE");
  assert.equal(await page.locator("#eraseGo").isEnabled(), true);
  await page.locator("#eraseGo").click();
  await page.locator("#onboardScreen h1").getByText("Choose your subjects").waitFor();
  assert.equal((await admin.from("tasks").select("id").eq("user_id", id)).data.length, 0);
  console.log("PASS: public Settings confirms, cancels, and returns the reset account to onboarding.");
} finally {
  await browser?.close();
  const { error } = await admin.auth.admin.deleteUser(created.user.id);
  if (error) console.error(`Could not remove throwaway user: ${error.message}`);
}
