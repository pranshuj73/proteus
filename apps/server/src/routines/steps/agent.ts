import {
  type RoutineAgentStep,
  type RoutineSkillStep,
  type RoutineVerdict,
  routineStepVerdictLabels,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RoutineThreadRunner } from "../adapters/threads.ts";
import type { RoutineStepContext, RoutineStepOutcome } from "./StepRunner.ts";

const OUTPUT_EXCERPT_BYTES = 16384;

const verdictInstruction = (labels: ReadonlyArray<string>): string =>
  `When done, end your reply with a line:\nVERDICT: <one of ${labels.join("|")}> - <one-line reason>`;

const buildPrompt = (
  step: RoutineAgentStep | RoutineSkillStep,
  labels: ReadonlyArray<string>,
  brief: string,
): string => {
  const context = brief.trim().length > 0 ? `Routine brief:\n${brief.trim()}\n\n` : "";
  if (step.kind === "agent") {
    return `${context}${step.purpose}\n\n${verdictInstruction(labels)}`;
  }
  const skillName = step.skill.includes("@")
    ? step.skill.slice(step.skill.indexOf("@") + 1)
    : step.skill;
  return `${context}Use the "${skillName}" skill.\n${step.prompt ?? ""}\n\n${verdictInstruction(labels)}`;
};

/** Parses the trailing `VERDICT: <label> - <reason>` line; defaults when absent or unknown. */
const parseVerdict = (text: string, labels: ReadonlyArray<string>): RoutineVerdict => {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index]?.match(/^\s*verdict:\s*(.+)$/i);
    if (match === null || match === undefined) continue;
    const rest = (match[1] ?? "").trim();
    // A spaced hyphen or an em dash separates; kebab labels keep their inner hyphens.
    const separated = rest.match(/^(.+?)(?:\s+-\s+|\s*—\s*)(.*)$/);
    const label = (separated?.[1] ?? rest).trim();
    const reason = (separated?.[2] ?? "").trim();
    if (labels.includes(label)) {
      return { label, reason: reason.length > 0 ? reason : "verdict reported" };
    }
    break;
  }
  return { label: labels[0] ?? "", reason: "no verdict line; defaulted" };
};

const tailBytes = (text: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  return new TextDecoder().decode(encoded.slice(encoded.length - maxBytes));
};

/** Launches a thread for an agent/skill step and reads its trailing verdict line. */
export const runAgentOrSkillStep = Effect.fn("RoutineSteps.runAgentOrSkillStep")(function* (
  step: RoutineAgentStep | RoutineSkillStep,
  context: RoutineStepContext,
) {
  const threads = yield* RoutineThreadRunner;
  const labels = routineStepVerdictLabels(step);
  const prompt = buildPrompt(step, labels, context.brief);

  const result = yield* threads.runAgentStep({
    projectId: context.projectId,
    workspaceStrategy: context.workspaceStrategy,
    prompt,
    modelSelection: context.modelSelection,
    title: step.title ?? step.id,
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
  });

  return {
    verdict: parseVerdict(result.verdictText, labels),
    outputExcerpt: tailBytes(result.verdictText, OUTPUT_EXCERPT_BYTES),
    threadId: result.threadId,
  } satisfies RoutineStepOutcome;
});
