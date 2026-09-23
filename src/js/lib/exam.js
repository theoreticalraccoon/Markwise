/**
 * How exam material is written on screen.
 *
 * One place, so the library, recall, the assistant and the mock paper all say
 * the same thing the same way. Before this each screen built its own label from
 * the internal paper code, which showed students "E-4MA1_s24_qp_1H Q1(a)": a
 * filename, with the board prefix the repo uses to tell boards apart.
 *
 * What a student recognises is the paper as Pearson prints it:
 *
 *   4PH1 · Jun 2024 · Paper 1P · Q3(b)
 *
 * and marks the way the paper prints them, in brackets: (3).
 */

/** "E-4PH1" -> "4PH1". The board prefix is internal; students say 4PH1. */
export function displayCode(code) {
  return String(code ?? "").replace(/^[A-Z]-/, "");
}

/**
 * The paper reference, from the paper code.
 *
 * "E-4PH1_s24_qp_1P" -> "1P". It is the last of four parts; a syllabus code has
 * fewer, and has no reference.
 */
export function paperRefOf(paperCode) {
  const parts = String(paperCode ?? "").split("_");
  return parts.length === 4 ? parts[3].toUpperCase() : null;
}

/**
 * "4PH1 · Jun 2024 · Paper 1P · Q3(b)"
 *
 * Accepts a chunk row, a citation, or anything shaped like one. Every part is
 * optional, so a row missing its year or paper still gives a readable label.
 */
export function paperLabel(row, { question = true } = {}) {
  const code = row.subject_code ?? String(row.paper_code ?? "").split("_")[0];
  const ref = row.paper_ref || paperRefOf(row.paper_code);

  // Some queries return only the paper code. The series and year are in it
  // ("E-4PH1_s24_qp_1P": s = May/June, 24 = 2024), so read them from there
  // rather than showing a label with no date.
  let { session, year } = row;
  if (!session || !year) {
    const m = String(row.paper_code ?? "").match(/_([jmsw])(\d{2})_/);
    if (m) {
      session = session ?? { j: "Jan", m: "Mar", s: "Jun", w: "Nov" }[m[1]];
      year = year ?? 2000 + Number(m[2]);
    }
  }

  const bits = [displayCode(code)];
  if (session && year) bits.push(`${session} ${year}`);
  else if (year) bits.push(String(year));

  if (ref) bits.push(/^\d{4}$/.test(code) && /^\d{2}$/.test(ref) ? `Paper ${ref[0]} variant ${ref[1]}` : `Paper ${ref}`);
  else if (row.paper_no) bits.push(`Paper ${row.paper_no}${row.variant ?? ""}`);

  if (question && row.question_no) bits.push(`Q${row.question_no}`);
  return bits.filter(Boolean).join(" · ");
}

/** A mark allocation as the paper prints it: (3). */
export function markPill(marks) {
  return `(${marks})`;
}

/** Only stored boundary-based grades belong on a grade trend. */
export function gradeHistory(mocks, papers, subject = null) {
  const groups = new Map();
  const add = (row, route, at) => {
    const grade = String(row.grade ?? "");
    if ((subject && row.subject_code !== subject) || !/^(?:[1-9]|U)$/.test(grade) || !Number.isFinite(Date.parse(at))) return;
    if (!groups.has(row.subject_code)) groups.set(row.subject_code, []);
    groups.get(row.subject_code).push({
      id: row.id, grade, value: grade === "U" ? 0 : Number(grade), at, route,
      title: row.title ?? "Marked paper",
    });
  };
  for (const mock of mocks) {
    if (mock.status === "marked") add(mock, `mock/${mock.id}/marked`, mock.submitted_at ?? mock.created_at);
  }
  for (const paper of papers) add(paper, `markpaper/${paper.id}`, paper.created_at);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([subject, points]) => ({
    subject, points: points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  }));
}
