import { expect, it } from "@effect/vitest";

import type { RoutineDefinition } from "@t3tools/contracts";

import { extractJson, gradeCouncil, gradeHumanRouting } from "./grade.ts";

it("grades council replies on confidence and answer text", () => {
  const reply = { confidence: "low", answer: "Refused" };
  expect(gradeCouncil({ reply, expect: { confidence: "low" } })).toBe(true);
  expect(gradeCouncil({ reply, expect: { confidence: "high" } })).toBe(false);
  expect(gradeCouncil({ reply: null, expect: {} })).toBe(false);
});

it("extracts JSON from fenced replies", () => {
  expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(extractJson("no json")).toBeNull();
});

it("requires a human step to route its labels to different places", () => {
  const withHuman = (human: Record<string, unknown>) =>
    ({
      version: 1,
      name: "Sign-off",
      steps: [{ id: "approve", kind: "human", prompt: "Approve?", ...human }],
    }) as unknown as RoutineDefinition;
  const labels = { verdict: { labels: ["approved", "rejected"] } };

  expect(
    gradeHumanRouting(withHuman({ ...labels, on: { approved: "push", rejected: "$end" } })),
  ).toBe(true);
  expect(gradeHumanRouting(withHuman({ ...labels, next: ["push"] }))).toBe(false);
  expect(gradeHumanRouting(withHuman({ ...labels, on: { approved: "push" } }))).toBe(false);
  expect(
    gradeHumanRouting(withHuman({ ...labels, on: { approved: "push", rejected: "push" } })),
  ).toBe(false);
  expect(
    gradeHumanRouting(withHuman({ verdict: { labels: ["approved"] }, on: { approved: "push" } })),
  ).toBe(false);
});
