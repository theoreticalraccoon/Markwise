/**
 * Upload smoke test for the two in-app document routes. A non-admin must be
 * refused by /ingest; /mark-paper must read a real file and refuse politely
 * rather than invent marks.
 *
 *   npm run test:upload
 */
import { readFile, stat } from "node:fs/promises";
import { globSync } from "node:fs";
import { join, basename } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config();

const SUPABASE = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
const FN = `${SUPABASE}/functions/v1`;
const PDF_DIR = new URL("./pdfs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const admin = createClient(SUPABASE, SERVICE, { auth: { persistSession: false } });
const email = `upload-${Date.now()}@example.com`;
const password = "uploaduploaded1234";
const { data: created, error: cErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (cErr) throw new Error(cErr.message);
const userId = created.user.id;

const problems = [];
const check = (ok, what, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) problems.push(what);
};

try {
  const anon = createClient(SUPABASE, ANON, { auth: { persistSession: false } });
  const { data: s } = await anon.auth.signInWithPassword({ email, password });
  const headers = {
    Authorization: `Bearer ${s.session.access_token}`,
    apikey: ANON,
    "Content-Type": "application/json",
  };

  // The smallest question paper, because it also stands in for a photo sent to
  // mark-paper, and a 30-page paper risks the function's compute limit.
  const candidates = globSync("**/*_qp_*.pdf", { cwd: PDF_DIR });
  if (!candidates.length) throw new Error("No question-paper PDF in ingest/pdfs to test with.");
  const sized = await Promise.all(candidates.map(async (f) => ({ f, size: (await stat(join(PDF_DIR, f))).size })));
  sized.sort((a, b) => a.size - b.size);
  const qp = sized[0].f;

  /* ------------------------------------------------------------- ingest -- */
  console.log(`\ningest  (${basename(qp)})`);
  {
    // Throwaway users are not admins; ingest must stay closed to them.
    const data = (await readFile(join(PDF_DIR, qp))).toString("base64");
    const res = await fetch(`${FN}/ingest`, {
      method: "POST", headers,
      body: JSON.stringify({ fileName: basename(qp), file: { mimeType: "application/pdf", data } }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) {
      check(true, "a non-admin is refused", body.message?.slice(0, 70));
    } else if (res.ok) {
      check(false, "a non-admin should not be able to write to the shared corpus", `got ${res.status}`);
    } else {
      check(false, "ingest responded", `${res.status} ${body.message ?? body.error ?? ""}`);
    }
  }

  /* ---------------------------------------------------------- mark-paper -- */
  console.log("\nmark-paper");
  {
    const { data: papers } = await admin.from("papers")
      .select("id,title,subject_code").eq("kind", "qp").limit(1);
    if (!papers?.length) {
      check(false, "a paper exists to mark against");
    } else {
      // A question-paper page has no answers on it, so the route should say so.
      const data = (await readFile(join(PDF_DIR, qp))).toString("base64");
      const res = await fetch(`${FN}/mark-paper`, {
        method: "POST", headers,
        body: JSON.stringify({ subject: papers[0].subject_code, files: [{ mimeType: "application/pdf", data }] }),
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 409 && body.error === "paper_not_held") {
        check(true, "refuses to mark a paper it does not hold", body.message.slice(0, 70));
      } else if (res.status === 422 && body.error === "no_answers") {
        check(true, "refuses to mark when it cannot find answers", body.message.slice(0, 60));
      } else if (res.ok) {
        check(true, "returned a marked paper", `${body.awarded}/${body.total} (${body.pct}%)`);
        check(Array.isArray(body.questions) && body.questions.length > 0, "per-question results");
        const overAwarded = (body.questions ?? []).filter((q) => q.awarded !== null && q.awarded > q.marks);
        check(overAwarded.length === 0, "never awards more than a question is worth");
      } else {
        check(false, "mark-paper responded", `${res.status} ${body.message ?? body.error ?? ""}`);
      }
    }
  }

  /* --------------------------------------------------------------- quota -- */
  console.log("\nallowance");
  {
    const user = createClient(SUPABASE, ANON, {
      global: { headers: { Authorization: `Bearer ${s.session.access_token}` } },
      auth: { persistSession: false },
    });
    const { data: usage } = await user.rpc("my_ai_usage");
    const routes = (usage ?? []).map((u) => u.route);
    check(routes.includes("ingest"), "ingest is metered");
    check(routes.includes("markpaper"), "markpaper is metered");
  }
} finally {
  await admin.from("attempts").delete().eq("user_id", userId);
  await admin.auth.admin.deleteUser(userId).catch(() => {});
  console.log("\nthrowaway user deleted.");
}

console.log(problems.length ? `\n${problems.length} PROBLEM(S)` : "\nUpload routes: working.");
process.exit(problems.length ? 1 : 0);
