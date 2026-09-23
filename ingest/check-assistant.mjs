/** Live refusal regression checks. Creates and removes one disposable user. */
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { db } from "./lib/db.js";

const anon = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const email = `assistant-check-${Date.now()}@example.com`;
const password = crypto.randomUUID();
const { data: created, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
if (error) throw error;
let failures = 0;
try {
  const client = createClient(process.env.SUPABASE_URL, anon, { auth: { persistSession: false } });
  const { data, error: signError } = await client.auth.signInWithPassword({ email, password });
  if (signError) throw signError;
  const cases = [
    ["E-4CH1", "Can you please explain electrolysis to me?", /ion|electrode|current/i],
    ["E-4CH1", "What do I need to know about electrolysis for my 2026 exam?", /ion|electrode|current/i],
    ["E-4BI1", "Explain how enzymes work", /active site|catalyst|substrate/i],
    ["E-4MA1", "How do I find the nth term of an arithmetic sequence?", /difference|an? \+|dn|n-th|nth/i],
    ["E-4PH1", "Explain the difference between series and parallel circuits", /current|voltage|potential difference/i],
    ["E-4CH1", "Why does that happen?", /ion|electrode|electron/i,
      [{ role: "user", text: "Why must sodium chloride be molten for electrolysis?" }]],
    ["E-4CH1", "Explain E-4CH1_s24_qp_1C Q99", null],
  ];
  for (const [subject, question, expected, history] of cases) {
    console.log(`Checking ${subject}: ${question}`);
    try {
      const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/ask`, {
        method: "POST", signal: AbortSignal.timeout(120000),
        headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({ subject, question, history }),
      });
      assert.ok(response.ok, `HTTP ${response.status}: ${response.ok ? "" : await response.text()}`);
      let answer = "", citations = [], done = false;
      for (const frame of (await response.text()).split(/\r?\n\r?\n/)) {
        const event = frame.match(/event: (.+)/)?.[1];
        const payload = frame.match(/data: (.+)/)?.[1];
        if (!payload) continue;
        const value = JSON.parse(payload);
        if (event === "error") throw new Error(value.message);
        if (event === "delta") answer += value;
        if (event === "citations") citations = value.citations;
        if (event === "done") done = true;
      }
      console.log(JSON.stringify({ subject, question, sources: citations.length, answer }));
      assert.ok(done, "stream did not complete");
      if (expected === null) {
        assert.equal(citations.length, 0, "missing exact question was replaced by another source");
        assert.match(answer, /not|cannot|can't|couldn't|unable|missing|no |don't/i);
        continue;
      }
      assert.ok(citations.length, "no retrieved evidence");
      assert.match(answer, /\[\d+(?:,\s*\d+)*\]/, "no inline evidence citations");
      assert.match(answer, expected, "did not explain the requested topic");
      assert.doesNotMatch(answer, /^(?:the )?(?:provided )?sources (?:do not|don't|don't)|^I (?:cannot|can't) answer/i);
    } catch (e) { failures++; console.error(`FAIL ${question}: ${e.message}`); }
  }
} finally {
  const { error: cleanup } = await db.auth.admin.deleteUser(created.user.id);
  if (cleanup) throw cleanup;
}
console.log(`Assistant checks: ${failures} failed`);
if (failures) process.exitCode = 1;
