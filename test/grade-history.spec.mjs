import assert from "node:assert/strict";
import { test } from "node:test";
import * as exam from "../src/js/lib/exam.js";

const mocks = [
  { id: "later", subject_code: "E-4MA1", status: "marked", grade: "7", submitted_at: "2026-09-20T10:00:00Z" },
  { id: "earlier", subject_code: "E-4MA1", status: "marked", grade: "5", submitted_at: "2026-09-10T10:00:00Z" },
  { id: "unfinished", subject_code: "E-4MA1", status: "ready", grade: "9", created_at: "2026-09-21T10:00:00Z" },
  { id: "unknown", subject_code: "E-4MA1", status: "marked", grade: null, submitted_at: "2026-09-19T10:00:00Z" },
];
const papers = [
  { id: "physics", subject_code: "E-4PH1", grade: "U", created_at: "2026-09-18T10:00:00Z" },
  { id: "middle", subject_code: "E-4MA1", grade: "6", created_at: "2026-09-15T10:00:00Z" },
  { id: "legacy", subject_code: "0625", grade: "A*", created_at: "2026-09-15T10:00:00Z" },
];

test("grade history combines marked mocks and uploaded papers in date order per subject", () => {
  const history = exam.gradeHistory?.(mocks, papers);
  assert.deepEqual(history?.map((s) => [s.subject, s.points.map((p) => [p.id, p.grade])]), [
    ["E-4MA1", [["earlier", "5"], ["middle", "6"], ["later", "7"]]],
    ["E-4PH1", [["physics", "U"]]],
  ]);
});

test("grade history respects the chosen subject and links each result to its own view", () => {
  const history = exam.gradeHistory?.(mocks, papers, "E-4MA1");
  assert.equal(history?.length, 1);
  assert.deepEqual(history?.[0].points.map((p) => p.route), ["mock/earlier/marked", "markpaper/middle", "mock/later/marked"]);
});

test("unknown grades and invalid dates are never charted as a grade zero", () => {
  const history = exam.gradeHistory?.([], [
    ...papers,
    { id: "missing", subject_code: "E-4MA1", grade: "", created_at: "2026-09-20" },
    { id: "date", subject_code: "E-4MA1", grade: "9", created_at: "invalid" },
  ]);
  assert.deepEqual(history?.flatMap((s) => s.points.map((p) => [p.id, p.value])), [["middle", 6], ["physics", 0]]);
});
