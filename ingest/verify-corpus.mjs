/** Read-only acceptance gate. Run before and after completing corpus work. */
import { db } from "./lib/db.js";

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!condition) failures++;
}
async function rows(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}
async function count(query) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return count;
}

const subjects = await rows(db.from("subjects").select("code,name").eq("active", true).eq("board", "Edexcel"));
const coverage = await rows(db.from("corpus_coverage").select("*"));
check("active Edexcel catalogue is present", subjects.length >= 19, `${subjects.length} subjects`);
for (const subject of subjects) {
  const row = coverage.find((c) => c.subject_code === subject.code);
  check(`${subject.name} has questions`, row?.questions > 0, `${row?.questions ?? 0}`);
  check(`${subject.name} has specification sections`, row?.syllabus_sections >= 2, `${row?.syllabus_sections ?? 0}`);
  const markable = await count(db.from("chunks").select("id", { count: "exact", head: true })
    .eq("subject_code", subject.code).eq("kind", "question").not("ms_content", "is", null));
  check(`${subject.name} supports marking`, markable > 0, `${markable} markable questions`);
}
for (const [label, query] of [
  ["embedding backlog cleared", db.from("chunks").select("id", { count: "exact", head: true }).is("embedding", null)],
  ["questions classified", db.from("chunks").select("id", { count: "exact", head: true }).eq("kind", "question").is("topic", null)],
  ["question schemes paired", db.from("chunks").select("id", { count: "exact", head: true }).eq("kind", "question").is("ms_content", null)],
]) {
  const missing = await count(query);
  check(label, missing === 0, `${missing} remaining`);
}
console.log(`\n${failures} unmet corpus requirements`);
process.exitCode = failures ? 1 : 0;
