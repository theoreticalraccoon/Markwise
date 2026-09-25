/**
 * Pair question parts with mark-scheme rows. The two PDFs number things
 * differently ("4(b)(ii)", "4 b ii", "4bii"), so matching runs strictest first
 * and leaves anything doubtful unpaired. A wrong pairing marks an answer
 * against someone else's scheme, which is the worst thing this app can do.
 */

/** '4(b)(ii)' → '4bii' */
function key(no) {
  return String(no ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Merge parallel language editions of one mark scheme by question number. */
export function combineMarkSchemeVariants(variants) {
  const combined = new Map();
  for (const variant of variants) {
    for (const row of variant.rows) {
      const k = key(row.questionNo);
      if (!k) continue;
      if (!combined.has(k)) combined.set(k, { row, versions: [] });
      combined.get(k).versions.push({ label: variant.label, text: row.text });
    }
  }

  return [...combined.values()].map(({ row, versions }) => {
    const unique = [...new Set(versions.map((version) => version.text))];
    if (unique.length === 1) return { ...row, text: unique[0] };
    return {
      ...row,
      text: versions.map((version) => `${version.label}:\n${version.text}`).join("\n\n"),
    };
  });
}

/** '4(b)(ii)' → ['4','b','ii'] */
function segments(no) {
  const k = key(no);
  const m = k.match(/^([ab]?\d+)([a-h])?((?:i|v|x)+)?$/);
  return m ? [m[1], m[2] ?? "", m[3] ?? ""] : [k];
}

export function pairQuestions(questions, msRows) {
  const byKey = new Map();
  const ambiguous = new Set();
  for (const r of msRows) {
    const k = key(r.questionNo);
    const existing = byKey.get(k);
    if (existing && (existing.text !== r.text || existing.marks !== r.marks)) ambiguous.add(k);
    if (k && !byKey.has(k)) byKey.set(k, r);
  }

  const stats = { exact: 0, normalised: 0, root: 0, unmatched: 0 };

  const paired = questions.map((q) => {
    const qk = key(q.questionNo);
    if (ambiguous.has(qk)) {
      stats.unmatched++;
      return { ...q, msText: null, msMarks: null };
    }

    // 1. Exact key match.
    let ms = byKey.get(qk);
    if (ms) {
      stats.exact++;
      return merge(q, ms);
    }

    // 2. Same question and part, allowing only a missing sub-part level. The
    //    part must match exactly: marking 4(b) against all of Q4 is worse
    //    than not marking it.
    const [qn, qp, qs] = segments(q.questionNo);
    const normalised = [];
    for (const [k, row] of byKey) {
      const [rn, rp, rs] = segments(k);
      if (rn !== qn) continue;
      if ((qp || "") !== (rp || "")) continue;
      if (qs && rs && qs !== rs) continue;
      normalised.push({ row, ambiguous: ambiguous.has(k) });
    }
    if (normalised.length === 1 && !normalised[0].ambiguous) {
      stats.normalised++;
      return merge(q, normalised[0].row);
    }

    // 3. Whole-question fallback, only for questions with no parts.
    if (!qp && !qs) {
      const rootRow = byKey.get(qn);
      if (rootRow) {
        stats.root++;
        return merge(q, rootRow);
      }

      // ICT sometimes calls a task "B5" while the scheme's only row is "B5(a)".
      // Safe only when there is exactly one such row.
      if (/^[ab]\d+$/i.test(String(q.questionRoot))) {
        const candidates = msRows.filter((row) =>
          key(row.questionRoot) === key(q.questionRoot),
        );
        if (candidates.length === 1) {
          stats.root++;
          return merge(q, candidates[0]);
        }
      }
    }

    stats.unmatched++;
    return { ...q, msText: null, msMarks: null };
  });

  return { paired, stats };
}

function merge(q, ms) {
  return {
    ...q,
    msText: ms.text,
    msMarks: ms.marks ?? null,
    // The paper's own [n] is authoritative; the scheme's count is the fallback.
    marks: q.marks ?? ms.marks ?? null,
  };
}

/** Examiner-report commentary, matched by root question only. Context, never marking authority. */
export function attachExaminerReport(paired, reportPages) {
  if (!reportPages?.length) return paired;
  const text = reportPages.map((p) => p.text).join("\n");
  const sections = new Map();

  const re = /question\s*(\d{1,2})\s*(?:\(([a-h])\))?/gi;
  const marks = [...text.matchAll(re)];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const root = marks[i][1];
    const body = text.slice(start, end).trim();
    if (body.length < 40) continue;
    sections.set(root, (sections.get(root) ?? "") + "\n" + body);
  }

  return paired.map((q) => ({
    ...q,
    erText: sections.get(String(q.questionRoot))?.trim().slice(0, 2000) ?? null,
  }));
}
