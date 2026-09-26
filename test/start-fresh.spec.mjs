import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";

test("start fresh covers every student-owned table in one authenticated database call", async () => {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const migrations = await readdir(directory);
  const schema = (await Promise.all(migrations.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n");
  const owned = [...schema.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)]
    .filter((match) => /^\s*user_id\b/m.test(match[2]))
    .map((match) => match[1])
    .filter((name) => !["ai_usage", "admins"].includes(name));

  const reset = await readFile(new URL("../supabase/migrations/20260926000000_start_fresh.sql", import.meta.url), "utf8");
  const body = reset.match(/create or replace function public\.reset_my_data\(\)([\s\S]*?)\$fn\$;/i)?.[1];
  assert.ok(body, "reset_my_data must be a database function");
  for (const table of owned) {
    assert.match(body, new RegExp(`delete from public\\.${table}\\s+where user_id = me\\s*;`, "i"), `${table} is not erased`);
  }
  for (const field of ["subjects", "onboarded", "prefs", "exam_session", "display_name", "board"]) {
    assert.match(body, new RegExp(`\\b${field}\\s*=`), `${field} is not reset`);
  }
  assert.match(body, /me\s+uuid\s*:=\s*auth\.uid\(\)/i);
  assert.match(reset, /revoke execute on function public\.reset_my_data\(\) from public, anon/i);
  assert.match(reset, /grant execute on function public\.reset_my_data\(\) to authenticated/i);

  const data = await readFile(new URL("../src/js/api/data.js", import.meta.url), "utf8");
  assert.match(data, /sb\.rpc\("reset_my_data"\)/);
  assert.doesNotMatch(data, /const PERSONAL_TABLES/);
});
