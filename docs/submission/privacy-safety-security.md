# Privacy, safety, security, limitations and future improvements

## Privacy

**What we store.** An email address and password (handled by Supabase Auth; we never see the
password), the subjects a student picked, their homework tasks, and their study record: answers
they had marked, mocks, flashcard reviews and topic scores. No names, school, age or location.

**Who can see it.** Only the student. Every table holding student data has row-level security
in the database itself, so even a bug in our app code can't return another student's rows. The
security test proves this on the live database (15 of 15 checks, [testing.md](testing.md)).

**What leaves the app.** To answer or mark, the student's question or answer text, plus
photos of their paper for "mark a paper", are sent to Google's Gemini API. We use Gemini's free
tier, and Google's terms allow it to use free-tier inputs to improve its products. Students
shouldn't type personal information into questions; a school deployment should move to a
paid key, where Google doesn't use the data that way.

**Deleting it.** Settings, Start fresh, deletes everything above in one step and sends the
student back to picking subjects. It keeps only the sign-in itself and today's AI usage count,
so wiping your data can't be used to reset the daily allowance. A test checks that the reset
covers every table holding student data, so a new table can't be missed.

**On shared devices.** Signing out deletes the offline copy of the student's work from the
browser (tested: "sign out: saved offline work is removed").

## Safety

The main risk with an AI study tool isn't physical. It's a confident wrong answer that a
student then learns, or a made-up mark that tells them they're ready when they aren't. Most of
Markwise's design is aimed at that:

- The assistant only answers from retrieved past-paper sources and cites each claim. If the
  sources don't cover it, it says so. Asked about a question that doesn't exist (Q99), it
  refused rather than inventing one.
- Marking uses the real mark scheme and Pearson's own conventions. A question with no mark
  scheme is shown as unmarkable, not guessed. The server caps every mark at the question's
  total.
- Mock papers are rebuilt word for word from the database; anything the model writes itself
  is thrown away.
- A wrong pairing of question and mark scheme is worse than none, so ambiguous pairings are
  left empty.
- Grades are shown as "predicted", from the most recent real grade boundaries. They're a
  revision aid, not a replacement for a teacher.

## Security

- **Keys.** The Gemini keys live only in Supabase's function secrets. The database's
  full-access key lives only in `ingest/.env` on the machine that loads papers, and it's
  gitignored. The browser holds only the publishable key, which can't do anything row-level
  security doesn't allow.
- **The corpus is read-only to students.** Adding a paper changes what every student is marked
  against, so only admins can (checked in `ingest/index.ts` and tested).
- **Database functions** that spend or refund the AI allowance can't be called by students
  directly; only the edge functions can.
- **Abuse limits.** Each student has a daily allowance per AI feature (60 questions, 40
  marks, 8 mocks and so on), enforced in the database.
- **Deployment.** Vercel serves only the browser files; nothing from `ingest/`, `supabase/` or
  any `.env` file is deployed.
- **Tests clean up.** Every live test creates throwaway accounts and deletes them afterwards.

## Copyright

Past papers, mark schemes, examiner reports and specifications are © Pearson Education
Limited. We downloaded them only from Pearson's own website, rate-limited, skipping anything
behind the teacher login and anything under Pearson's 12-month embargo. The material is
licensed for personal and school use, so Markwise is a private deployment for us and our
school, not a public service. Nothing from the corpus is in the repository.

## Limitations

- **Embeddings.** Only 9.1% of question parts have embeddings so far, because the free Gemini
  quota covers a few hundred a day. Search falls back to keywords, which finds a pasted
  question in the top 5 87.7% of the time but handles loosely worded questions less well.
- **Marking isn't validated against teachers.** Our calibration test shows the marker ranks
  full, half and blank answers correctly, but we haven't compared it with a real examiner.
- **Parsing gaps.** 45 question parts include equation-booklet text; 178 have no mark scheme;
  some maths symbols came out as ☒; topic tags are incomplete for History, Double Science and
  English Language B.
- **Lettered references.** "History Paper 1 Q A1(b)" isn't recognised as an exact reference
  yet.
- **Diagrams.** Questions are stored as text. A question that depends on a graph or diagram
  can be read but not seen.
- **Free-tier limits.** On a busy day the shared quota can run out, and AI features stop until
  midnight UTC. Recall and the planner keep working.

## Future improvements

1. Finish embedding the corpus (a few days of daily runs, or a paid key).
2. Ask our teachers to mark 30 to 50 real student answers blind, and compare with Markwise.
3. Store page images alongside text so diagram questions show their diagram.
4. Fix the booklet contamination and lettered references, then re-ingest the affected papers.
5. Let teachers set work from the corpus and see class-wide weak topics.
6. Clean up the architecture where the review found duplication: one module for what a paper
   reference means, one for marking, one for the allowance.
