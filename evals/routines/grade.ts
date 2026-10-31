import type { RoutineDefinition } from "@t3tools/contracts";

export interface CouncilGradeInput {
  readonly reply: { readonly confidence: string; readonly answer: string } | null;
  readonly expect: { readonly confidence?: string; readonly answerIncludes?: string };
}

export const gradeCouncil = ({ reply, expect }: CouncilGradeInput): boolean => {
  if (reply === null) return false;
  if (expect.confidence !== undefined && reply.confidence !== expect.confidence) return false;
  return (
    expect.answerIncludes === undefined ||
    reply.answer.toLowerCase().includes(expect.answerIncludes.toLowerCase())
  );
};

/** Pulls the first fenced or bare JSON object out of a model reply. */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

export const gradeRoutine = (
  definition: RoutineDefinition,
  expectKinds: ReadonlyArray<string>,
): boolean => expectKinds.every((kind) => definition.steps.some((step) => step.kind === kind));
