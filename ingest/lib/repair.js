/** Return database patches only where the local parser proved an exact pair. */
export function selectPairingRepairs(chunks, pairedQuestions) {
  const byQuestion = new Map(
    pairedQuestions
      .filter((question) => question.msText)
      .map((question) => [question.questionNo, question.msText]),
  );
  return chunks
    .filter((chunk) => !chunk.ms_content && byQuestion.has(chunk.question_no))
    .map((chunk) => ({ id: chunk.id, ms_content: byQuestion.get(chunk.question_no) }));
}
