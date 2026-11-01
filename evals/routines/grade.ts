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
/** A proposal names the ref, its popularity and link, and does not claim to be installed. */
export const gradeSkillProposal = (reply: string, ref: string, url: string): boolean =>
  reply.includes(ref) &&
  reply.includes(url) &&
  /859[,.]?4|859k|860k/i.test(reply) &&
  !/\b(i(?:'ve| have)? installed|npx skills add)\b/i.test(reply);

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

/** A real sign-off gives the person at least two choices that lead to different places. */
export const gradeHumanRouting = (definition: RoutineDefinition): boolean =>
  definition.steps.some(
    (step) =>
      step.kind === "human" &&
      step.verdict.labels.length >= 2 &&
      step.verdict.labels.every((label) => step.on?.[label] !== undefined) &&
      new Set(step.verdict.labels.map((label) => step.on?.[label])).size >= 2,
  );
