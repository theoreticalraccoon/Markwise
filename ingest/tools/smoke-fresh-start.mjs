import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publicKey = process.env.SUPABASE_ANON_KEY || "sb_publishable_q9kbWXGMCrLKmg-1aqBCMQ_k-i2CR77";
if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const owned = [
  "chat_messages", "chat_threads", "attempts", "topic_mastery", "mocks",
  "paper_attempts", "recall_reviews", "tasks", "tuition_sessions",
];
const users = [];

async function one(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function makeUser(label) {
  const email = `markwise-fresh-${label}-${Date.now()}@example.com`;
  const password = "markwise-test-1234";
  const created = await one(admin.auth.admin.createUser({ email, password, email_confirm: true }));
  users.push(created.user.id);
  const client = createClient(url, publicKey, { auth: { persistSession: false } });
  await one(client.auth.signInWithPassword({ email, password }));
  return { id: created.user.id, client };
}

try {
  const alice = await makeUser("a");
  const bob = await makeUser("b");
  const chunk = (await one(admin.from("chunks").select("id").limit(1))).at(0);
  assert.ok(chunk, "A corpus chunk is required to seed a recall review");

  await one(admin.from("profiles").insert([
    { id: alice.id, subjects: ["E-4MA1"], onboarded: true, display_name: "Alice", exam_session: "Jun 2027", prefs: { lastSubject: "E-4MA1" } },
    { id: bob.id, subjects: ["E-4PH1"], onboarded: true, display_name: "Bob", prefs: {} },
  ]));
  await one(admin.from("tasks").insert([
    { user_id: alice.id, subject: "E-4MA1", text: "Alice task" },
    { user_id: bob.id, subject: "E-4PH1", text: "Bob task" },
  ]));
  await one(admin.from("tuition_sessions").insert({ user_id: alice.id, subject: "E-4MA1", weekday: 1, start_time: "16:00" }));
  await one(admin.from("attempts").insert({ user_id: alice.id, subject_code: "E-4MA1", answer_text: "Alice answer" }));
  await one(admin.from("topic_mastery").insert({ user_id: alice.id, subject_code: "E-4MA1", topic: "Algebra" }));
  await one(admin.from("mocks").insert({ user_id: alice.id, subject_code: "E-4MA1", title: "Alice mock" }));
  await one(admin.from("paper_attempts").insert({ user_id: alice.id, subject_code: "E-4MA1", title: "Alice paper" }));
  await one(admin.from("recall_reviews").insert({ user_id: alice.id, chunk_id: chunk.id, subject_code: "E-4MA1" }));
  const thread = await one(admin.from("chat_threads").insert({ user_id: alice.id, title: "Alice chat" }).select("id").single());
  await one(admin.from("chat_messages").insert({ thread_id: thread.id, user_id: alice.id, role: "user", content: "Alice question" }));
  await one(admin.from("ai_usage").insert({ user_id: alice.id, route: "ask" }));

  const anon = createClient(url, publicKey, { auth: { persistSession: false } });
  const anonymous = await anon.rpc("reset_my_data");
  assert.ok(anonymous.error, "An anonymous caller must not be able to reset data");

  await one(alice.client.rpc("reset_my_data"));
  await one(alice.client.rpc("reset_my_data"));

  for (const table of owned) {
    const rows = await one(admin.from(table).select("user_id").eq("user_id", alice.id));
    assert.equal(rows.length, 0, `${table} still has Alice's data`);
  }
  const profile = await one(admin.from("profiles").select("subjects,onboarded,prefs,exam_session,display_name,board").eq("id", alice.id).single());
  assert.deepEqual(profile.subjects, []);
  assert.equal(profile.onboarded, false);
  assert.deepEqual(profile.prefs, {});
  assert.equal(profile.exam_session, null);
  assert.equal(profile.display_name, null);
  assert.equal(profile.board, "Edexcel");
  assert.equal((await one(admin.from("ai_usage").select("id").eq("user_id", alice.id))).length, 1);
  assert.equal((await one(admin.from("tasks").select("id").eq("user_id", bob.id))).length, 1);
  assert.equal((await one(admin.from("profiles").select("display_name").eq("id", bob.id).single())).display_name, "Bob");
  assert.equal((await one(admin.auth.admin.getUserById(alice.id))).user.id, alice.id);
  console.log("PASS: reset erases one user's study data atomically and preserves the account, quota, and other users.");
} finally {
  for (const id of users) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) console.error(`Could not remove throwaway user ${id}: ${error.message}`);
  }
}
