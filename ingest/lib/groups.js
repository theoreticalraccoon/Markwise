const LANGUAGE_SCHEMES = {
  "2A": "Python",
  "2B": "C#",
  "2C": "Java",
};

/**
 * Pearson published the 2021-2022 Computer Science Paper 02 once, but split
 * its mark scheme into 2A/2B/2C language editions. Attach those scheme-only
 * groups to the shared paper while leaving later, real 2A question papers
 * alone.
 */
export function attachLanguageSchemeVariants(groups) {
  for (const group of groups.values()) {
    const meta = group.meta;
    if (meta.subjectCode !== "E-4CP0" || meta.paperRef !== "02" || !group.files.qp || group.files.ms) continue;

    const variants = [];
    for (const [id, candidate] of groups) {
      const ref = candidate.meta.paperRef;
      if (!LANGUAGE_SCHEMES[ref]
          || candidate.meta.subjectCode !== meta.subjectCode
          || candidate.meta.year !== meta.year
          || candidate.meta.session !== meta.session
          || candidate.files.qp
          || !candidate.files.ms) continue;
      variants.push({ label: LANGUAGE_SCHEMES[ref], path: candidate.files.ms, paperRef: ref });
      groups.delete(id);
    }

    variants.sort((a, b) => a.paperRef.localeCompare(b.paperRef));
    if (variants.length) group.files.msVariants = variants;
  }
  return groups;
}
