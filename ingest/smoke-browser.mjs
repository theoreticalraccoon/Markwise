/**
 * Browser smoke test: drives the real UI in headless Chromium.
 *
 *   npm run test:browser        (from the repo root)
 *
 * Serves the repo, signs in as a throwaway user, walks every route and
 * exercises the interactions a student actually performs. Any console error,
 * page exception or failed request is a failure.
 *
 * This is the only check that executes the view layer. The unit tests cover
 * pure logic and the function smoke test covers the server, but neither one
 * would notice a template that throws on render.
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// fileURLToPath, not url.pathname: on Windows the latter yields "/C:/Users/…"
// with forward slashes, which never matches the back-slashed paths join()
// produces. So every request fails the containment check with a 403.
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const URL_SB = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const file = join(REPO, normalize(path === "/" ? "/index.html" : path));
    if (!file.startsWith(REPO)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const origin = process.env.MARKWISE_TEST_ORIGIN ?? `http://localhost:${server.address().port}`;
const screenshotDir = process.env.MARKWISE_SCREENSHOTS;

const admin = createClient(URL_SB, SERVICE, { auth: { persistSession: false } });
const email = `markwise-ui-${Date.now()}@example.com`;
const password = "markwise-ui-1234";
const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createErr) throw new Error(`could not create the test user: ${createErr.message}`);
const userId = created.user.id;

const problems = [];
const note = (where, what) => problems.push(`${where}: ${what}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

let scope = "boot";
page.on("console", (m) => {
  if (m.type() === "error") note(scope, `console: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => note(scope, `uncaught: ${String(e.message).slice(0, 200)}`));
page.on("requestfailed", (r) => {
  const f = r.failure()?.errorText ?? "";
  if (!/ERR_ABORTED/.test(f)) note(scope, `request failed: ${r.url().slice(0, 90)} ${f}`);
});

const step = async (name, fn) => {
  scope = name;
  const before = problems.length;
  try {
    await fn();
  } catch (e) {
    note(name, `threw: ${String(e.message).slice(0, 200)}`);
  }
  const added = problems.length - before;
  console.log(`  ${added ? "FAIL" : "ok  "}  ${name}${added ? ` (${added})` : ""}`);
};

try {
  console.log(`serving ${origin}\n`);

  await step("sign in", async () => {
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForSelector("#authEmail", { timeout: 15000 });
    await page.fill("#authEmail", email);
    await page.fill("#authPassword", password);
    await page.click("#authSubmit");
    await page.waitForSelector("#onboardGrid .subj", { timeout: 20000 });
  });

  await step("onboarding: pick subjects", async () => {
    const furtherPureSubjects = await page.locator("#onboardGrid .subj").evaluateAll((rows) =>
      rows
        .map((row) => row.textContent?.trim() ?? "")
        .filter((name) => /Further Pure Math/i.test(name))
    );
    if (furtherPureSubjects.length !== 1 || !/Further Pure Mathematics/i.test(furtherPureSubjects[0])) {
      throw new Error(`Expected one canonical Further Pure Mathematics subject, got ${JSON.stringify(furtherPureSubjects)}`);
    }
    await page.click('#onboardGrid .subj:has-text("Mathematics A") input');
    await page.click('#onboardGrid .subj:has-text("Physics") input');
    await page.click("#onboardContinue");
    await page.waitForSelector("#appShell:not([hidden])", { timeout: 20000 });
    await page.waitForSelector("#outlet .view-head", { timeout: 15000 });
  });

  await step("planner: add a task", async () => {
    await page.click(String.raw`[data-nav="planner"]`);
    await page.waitForSelector("#plannerBody", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#plannerBody .skeleton"), null, { timeout: 15000 });
    await page.click("#addTask");
    await page.waitForSelector("#taskForm", { timeout: 10000 });
    await page.fill("#tText", "Exercise 4B, questions 1-12");
    await page.fill("#tNotes", "bring the graph paper");
    await page.click(String.raw`#quickDates .chip:has-text("Tomorrow")`);
    await page.click("#taskSave");
    await page.waitForSelector("#taskForm", { state: "detached", timeout: 15000 });
    await page.waitForSelector(String.raw`.task-text:has-text("Exercise 4B")`, { timeout: 10000 });
  });

  await step("planner: tick, untick, tuition tab", async () => {
    await page.click(String.raw`.task:has-text("Exercise 4B") input[type="checkbox"]`);
    await page.waitForSelector(String.raw`.task.done:has-text("Exercise 4B")`, { timeout: 10000 });
    await page.click(String.raw`.task:has-text("Exercise 4B") input[type="checkbox"]`);
    await page.waitForSelector(String.raw`.task:not(.done):has-text("Exercise 4B")`, { timeout: 10000 });
    await page.click(String.raw`#sourceTabs button[data-source="tuition"]`);
    await page.waitForTimeout(250);
    await page.click(String.raw`#sourceTabs button[data-source="school"]`);
  });

  await step("planner: multiple tasks and category colours", async () => {
    const addTask = async (text, type) => {
      await page.click("#addTask");
      await page.waitForSelector("#taskForm", { timeout: 10000 });
      await page.click(`label[for="type-${type}"]`);
      await page.fill("#tText", text);
      await page.click("#taskSave");
      await page.waitForSelector("#taskForm", { state: "detached", timeout: 15000 });
      await page.waitForSelector(`.task-text:has-text("${text}")`, { timeout: 10000 });
    };
    await addTask("Complete the algebra review", "homework");
    await addTask("Chapter assessment", "assessment");
    await addTask("Timed topic test", "assessment");
    await addTask("Revise simultaneous equations", "revision");

    const state = await page.evaluate(() => {
      const rootStyle = getComputedStyle(document.documentElement);
      const groups = Object.fromEntries(["homework", "assessment", "revision"].map((type) => {
        const element = document.querySelector(`.card-group.${type}`);
        return [type, element ? getComputedStyle(element).backgroundColor : null];
      }));
      return {
        groups,
        tokens: ["--pen-soft", "--mark-soft", "--revision-soft"].map((name) => rootStyle.getPropertyValue(name).trim()),
        homework: document.querySelectorAll(".card-group.homework .task").length,
        assessments: document.querySelectorAll(".card-group.assessment .task").length,
      };
    });
    if (state.homework < 2 || state.assessments < 2) throw new Error("Planner did not retain multiple tasks of one type");
    if (Object.values(state.groups).some((value) => !value) || new Set(Object.values(state.groups)).size !== 3) {
      throw new Error(`Planner category surfaces are not distinct: ${JSON.stringify(state)}`);
    }
    if (new Set(state.tokens).size !== 3) throw new Error("Planner category theme tokens are not distinct");
  });

  let resumeMockId;
  await step("mock: answers survive reloading the app", async () => {
    const { data: saved, error } = await admin.from("mocks").insert({
      user_id: userId, subject_code: "E-4MA1", title: "Resume test paper",
      total_marks: 2, duration_min: 30, status: "ready",
      questions: [{ n: 1, marks: 2, text: "Calculate 2 + 3.", paperRef: "Test fixture" }],
    }).select("id").single();
    if (error) throw error;
    resumeMockId = saved.id;
    await page.goto(`${origin}/#/mock/${resumeMockId}`, { waitUntil: "networkidle" });
    await page.locator('.exam-answer[data-q="1"]').fill("5, by addition");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".exam-answer", { timeout: 20000 });
    if (await page.locator(".exam-answer").inputValue() !== "5, by addition") {
      throw new Error("Reload discarded the saved mock answer");
    }
  });

  await step("mock: current paper reopens offline with answers and timer", async () => {
    if (!resumeMockId) throw new Error("No mock was created for offline verification");
    await page.locator(".exam-answer").fill("5, saved for offline");
    const started = await page.locator("#examTimer").textContent();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.context().setOffline(true);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".exam-answer", { timeout: 15000 });
      if (await page.locator(".exam-answer").inputValue() !== "5, saved for offline") {
        throw new Error("Offline reload lost the saved answer");
      }
      if (!(await page.locator("#examTimer").textContent()) || !started) throw new Error("Timer missing offline");
      await page.locator(".exam-answer").fill("5, edited offline");
      if (!(await page.locator("#submitExam").isDisabled())) throw new Error("Offline submission is offered");
    } finally {
      await page.context().setOffline(false);
      await page.reload({ waitUntil: "networkidle" });
    }
  });

  await step("assistant: renders with composer at the bottom", async () => {
    await page.click(String.raw`[data-nav="assistant"]`);
    await page.waitForSelector("#chatInput", { timeout: 15000 });
    const box = await page.locator(".chat-composer").boundingBox();
    const vh = page.viewportSize().height;
    if (!box || box.y + box.height > vh + 4) note("assistant", "composer is not on screen");
    if (box && box.y < vh * 0.5) note("assistant", "composer is not at the bottom");
    await page.waitForSelector(".chip-suggest", { timeout: 10000 });
    const grounding = (await page.locator("#chatGrounding").textContent()) ?? "";
    if (!/Reading \d/.test(grounding.replace(/\s+/g, " "))) {
      note("assistant", `header does not state its sources: "${grounding.trim().slice(0, 60)}"`);
    }
  });

  await step("assistant: answers a question", async () => {
    await page.fill("#chatInput", "What does the command word calculate ask you to do?");
    await page.press("#chatInput", "Enter");
    await page.waitForSelector(".msg.user", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.querySelector(".msg.model .bubble")?.textContent ?? "").length > 40,
      null, { timeout: 180000 },
    );
    await page.waitForSelector(".sources .cite-pill", { timeout: 20000 });
  });

  await step("assistant: long history is paged, newest messages first", async () => {
    const { data: thread, error } = await admin.from("chat_threads").insert({
      user_id: userId, subject_code: "E-4MA1", title: "Pagination test thread",
    }).select("id").single();
    if (error) throw error;
    const messages = Array.from({ length: 120 }, (_, i) => ({
      thread_id: thread.id, user_id: userId, role: i % 2 ? "model" : "user",
      content: `History message number ${i + 1}.`,
      created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
    }));
    const { error: saveError } = await admin.from("chat_messages").insert(messages);
    if (saveError) throw saveError;
    await page.click("#historyBtn");
    await page.getByText("Pagination test thread", { exact: true }).click();
    await page.getByText("History message number 120.", { exact: true }).waitFor();
    if (await page.locator("#chatThread .msg").count() > 50) throw new Error("More than 50 messages rendered");
    await page.getByRole("button", { name: "Earlier messages", exact: true }).click();
    await page.getByText("History message number 70.", { exact: true }).waitFor();
    if (await page.locator("#chatThread .msg").count() > 50) throw new Error("History page is unbounded");
    await page.getByRole("button", { name: "Latest messages", exact: true }).click();
    await page.getByText("History message number 120.", { exact: true }).waitFor();
  });

  await step("mock: subject is the only input", async () => {
    await page.click(String.raw`[data-nav="mock"]`);
    await page.waitForSelector("#genBtn", { timeout: 20000 });
    for (const gone of ["#genMarks", "#genTime", "#genTopics", "#genWeak"]) {
      if (await page.locator(gone).count()) note("mock", `${gone} is still on screen`);
    }
    if (!(await page.locator("#genSubject").count())) note("mock", "no subject picker");
  });

  await step("mark a paper: three steps, and a history", async () => {
    await page.click(String.raw`[data-nav="markpaper"]`);
    await page.waitForSelector("#mpDrop", { timeout: 20000 });
    if (await page.locator("#mpPaper").count()) note("markpaper", "still asks which paper: should read it from the upload");
    const disabled = await page.locator("#mpGo").isDisabled();
    if (!disabled) note("markpaper", "Mark button is enabled with nothing uploaded");
    await page.waitForFunction(() => !document.querySelector("#mpHistory .skeleton"), null, { timeout: 20000 });
  });

  await step("library: browse the corpus", async () => {
    await page.click(String.raw`[data-nav="library"]`);
    await page.waitForSelector("#libSearch", { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector("#libBody .skeleton"), null, { timeout: 20000 });
    if (!(await page.locator(".lib-item").count())) note("library", "no questions listed");
    await page.click(".lib-item .lib-open");
    await page.waitForSelector(".modal .verbatim", { timeout: 15000 });
    const typography = await page.locator(".modal .verbatim").first().evaluate((element) => ({
      content: getComputedStyle(element).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
    }));
    await page.click(String.raw`[data-modal-close]`);
    if (typography.content !== typography.body || /mono|consolas|menlo/i.test(typography.content)) {
      throw new Error(`Exam content still uses the old monospace typeface: ${typography.content}`);
    }
  });

  await step("recall: a card, revealed and graded", async () => {
    await page.click(String.raw`[data-nav="recall"]`);
    await page.waitForSelector("#recallBody", { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector("#recallBody .spinner"), null, { timeout: 20000 });
    if (await page.locator(".recall-card").count()) {
      if (!(await page.locator(".recall-face.front").count())) throw new Error("Recall does not open on a flashcard front");
      if (screenshotDir) {
        await mkdir(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, "recall-front-1280.png"), fullPage: true });
      }
      await page.click("[data-reveal]");
      await page.waitForSelector(".recall-face.back", { timeout: 10000 });
      await page.waitForSelector(".recall-grades", { timeout: 10000 });
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, "recall-back-1280.png"), fullPage: true });
      await page.click(String.raw`[data-grade="2"]`);
      await page.waitForTimeout(400);
    } else {
      note("recall", "no cards offered (needs 1-3 mark questions with mark schemes)");
    }
  });

  await step("calendar: month grid and week strip", async () => {
    await page.click(String.raw`[data-nav="calendar"]`);
    await page.waitForSelector(".cal-grid", { timeout: 20000 });
    const days = await page.locator(".cal-day").count();
    if (days < 28) note("calendar", `only ${days} day cells drawn`);
    if (!(await page.locator(".week-day").count())) note("calendar", "no week strip");
  });

  await step("papers: reachable from settings; adding is admin-only", async () => {
    if (await page.locator(String.raw`.sidebar [data-nav="papers"]`).count()) {
      note("nav", "the corpus uploader is in the student sidebar; it belongs in settings");
    }
    await page.click(String.raw`[data-nav="settings"]`);
    await page.waitForSelector(String.raw`[data-nav="papers"]`, { timeout: 15000 });
    await page.click(String.raw`[data-nav="papers"]`);
    await page.waitForSelector("#pCoverage", { timeout: 15000 });
    // The throwaway user is an ordinary student. Adding papers replaces what
    // every student is marked against, so it must NOT be offered to them.
    if (await page.locator("#pDrop").count()) note("papers", "a student is offered the corpus uploader");
  });

  await step("planner: spines and equal card heights", async () => {
    await page.click(String.raw`[data-nav="planner"]`);
    await page.waitForSelector(".board .card", { timeout: 15000 });
    const rows = await page.$$eval(".board .card", (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      const bar = getComputedStyle(e, "::before");
      return {
        top: Math.round(r.top), h: Math.round(r.height),
        spine: [...e.classList].find((c) => c.startsWith("spine-")),
        bg: bar.backgroundImage, w: bar.width,
      };
    }));
    const firstRow = rows.filter((r) => r.top === rows[0].top);
    if (new Set(firstRow.map((r) => r.h)).size > 1) {
      note("planner", `cards in one row differ in height: ${firstRow.map((r) => r.h).join(", ")}`);
    }
    const both = rows.find((r) => r.spine === "spine-both");
    if (both && !/gradient/.test(both.bg)) {
      note("planner", "a card with homework and assessments does not show both pens");
    }
    if (rows.some((r) => r.w !== "3px")) note("planner", "spine bar missing on some cards");
  });

  await step("progress", async () => {
    await page.click(String.raw`[data-nav="progress"]`);
    await page.waitForSelector("#progBody", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#progBody .skeleton"), null, { timeout: 20000 });
  });

  await step("progress: per-subject grade history", async () => {
    const { error } = await admin.from("mocks").insert([
      { user_id: userId, subject_code: "E-4MA1", title: "Grade history first", status: "marked", grade: "5", submitted_at: "2026-09-01T12:00:00Z" },
      { user_id: userId, subject_code: "E-4MA1", title: "Grade history latest", status: "marked", grade: "7", submitted_at: "2026-09-15T12:00:00Z" },
    ]);
    if (error) throw error;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('.grade-history[data-grade-subject="E-4MA1"]');
    const chart = page.locator('.grade-history svg');
    if (!/5, 7/.test(await chart.getAttribute("aria-label"))) throw new Error("Grade history is missing or unordered");
    await page.selectOption("#progSubject", "E-4PH1");
    await page.waitForFunction(() => !document.querySelector(".grade-history"));
    await page.selectOption("#progSubject", "E-4MA1");
    await page.waitForSelector(".grade-history");
  });

  await step("settings", async () => {
    await page.click(String.raw`[data-nav="settings"]`);
    await page.waitForSelector("#subjGrid .subj", { timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("#tuitionPanel .spinner"), null, { timeout: 20000 });
    if (!(await page.locator("#examSession").count())) note("settings", "no exam-series field");
    await page.click(String.raw`label[for="theme-dark"]`);
    await page.waitForTimeout(150);
    await page.click(String.raw`label[for="theme-light"]`);
    await page.waitForFunction(() => !document.querySelector("#usagePanel .spinner"), null, { timeout: 20000 });
  });

  await step("mobile: chat composer stays on screen", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/#/assistant`, { waitUntil: "networkidle" });
    await page.waitForSelector("#chatInput", { timeout: 20000 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 2) note("mobile", `horizontal overflow of ${overflow}px`);
    const box = await page.locator(".chat-composer").boundingBox();
    if (!box || box.y + box.height > 844 + 4) note("mobile", "composer is off screen");
  });

  await step("responsive workspace: fonts, themes and route widths", async () => {
    const captureDir = screenshotDir;
    if (captureDir) await mkdir(captureDir, { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          localStorage.setItem("markwise-theme", value);
          document.documentElement.dataset.theme = value;
        }, theme);
        for (const route of ["planner", "assistant", "library", "recall", "progress", "settings"]) {
          await page.goto(`${origin}/#/${route}`, { waitUntil: "networkidle" });
          await page.waitForFunction(() => !document.querySelector('#outlet .skeleton, #outlet .spinner'), null, { timeout: 30000 });
          await page.evaluate(() => document.fonts.ready);
          const state = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - innerWidth,
            font: document.fonts.check('14px Geist'),
            content: document.querySelector('#outlet').textContent.trim().length,
          }));
          if (state.overflow > 2) throw new Error(`${route}/${theme}/${width}: overflow ${state.overflow}px`);
          if (!state.font || !state.content) throw new Error(`${route}: missing font or content`);
          if (captureDir) await page.screenshot({ path: join(captureDir, `${route}-${theme}-${width}.png`), fullPage: true });
        }
      }
    }
  });

  await step("sign out: saved offline work is removed", async () => {
    await page.evaluate(async () => {
      const { sb } = await import("/src/js/api/client.js");
      await sb.auth.signOut();
    });
    await page.waitForSelector("#authEmail");
    const remaining = await page.evaluate(() => Object.keys(localStorage).filter((key) =>
      key.startsWith("markwise-mock-") || key.startsWith("markwise-offline-")));
    if (remaining.length) throw new Error("Private offline work survived sign-out");
  });

} finally {
  await browser.close();
  server.close();
  await admin.from("tasks").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\nthrowaway user deleted.");
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log("  • " + p);
  process.exit(1);
}
console.log("\nBrowser: every route renders and every interaction works.");
