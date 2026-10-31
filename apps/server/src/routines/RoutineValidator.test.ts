import { RoutineDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { validateRoutine } from "./RoutineValidator.ts";

interface StepDraft {
  id: string;
  kind: string;
  title?: string;
  purpose?: string;
  skill?: string;
  prompt?: string;
  argv?: string[];
  verdict?: { labels: string[] };
  inputs?: string[];
  next?: string[];
  on?: Record<string, string>;
  onError?: string;
  join?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  retries?: number;
}

interface RoutineDraft {
  version: number;
  name: string;
  start: string;
  steps: StepDraft[];
}

const decode = Schema.decodeUnknownSync(RoutineDefinition);

const baseRoutine = (): RoutineDraft => ({
  version: 1,
  name: "demo",
  start: "plan",
  steps: [
    {
      id: "plan",
      kind: "agent",
      purpose: "plan the work",
      verdict: { labels: ["ready"] },
      next: ["impl-a", "impl-b"],
    },
    { id: "impl-a", kind: "command", argv: ["echo", "a"], maxIterations: 3, next: ["review"] },
    { id: "impl-b", kind: "command", argv: ["echo", "b"], next: ["review"] },
    {
      id: "review",
      kind: "agent",
      purpose: "review",
      verdict: { labels: ["approved", "revise"] },
      inputs: ["impl-a", "impl-b"],
      join: ["impl-a", "impl-b"],
      on: { approved: "$end", revise: "rework" },
    },
    {
      id: "rework",
      kind: "agent",
      purpose: "rework",
      verdict: { labels: ["ok"] },
      next: ["impl-a"],
    },
  ],
});

const cases: ReadonlyArray<{
  readonly code: string;
  readonly mutate: (routine: RoutineDraft) => void;
}> = [
  {
    code: "duplicate-step-id",
    mutate: (r) =>
      r.steps.push({ id: "plan", kind: "agent", purpose: "dup", verdict: { labels: ["x"] } }),
  },
  {
    code: "unknown-step-ref",
    mutate: (r) => {
      r.steps[0]!.next = ["nope", "impl-b"];
    },
  },
  {
    code: "next-and-on",
    mutate: (r) => {
      r.steps[0]!.on = { ready: "impl-a" };
    },
  },
  {
    code: "missing-transition",
    mutate: (r) => {
      r.steps[3]!.on = { approved: "$end" };
    },
  },
  {
    code: "unknown-label",
    mutate: (r) => {
      r.steps[3]!.on = { approved: "$end", revise: "rework", bogus: "$end" };
    },
  },
  {
    code: "duplicate-label",
    mutate: (r) => {
      r.steps[3]!.verdict = { labels: ["approved", "approved", "revise"] };
    },
  },
  {
    code: "input-not-earlier",
    mutate: (r) => {
      r.steps[3]!.inputs = ["rework"];
    },
  },
  {
    code: "loop-without-bound",
    mutate: (r) => {
      delete r.steps[1]!.maxIterations;
    },
  },
  {
    code: "unreachable-step",
    mutate: (r) =>
      r.steps.push({ id: "orphan", kind: "agent", purpose: "orphan", verdict: { labels: ["y"] } }),
  },
  {
    code: "invalid-skill-ref",
    mutate: (r) => {
      r.steps[4] = {
        id: "rework",
        kind: "skill",
        skill: "bad skill!",
        verdict: { labels: ["ok"] },
        next: ["impl-a"],
      };
    },
  },
];

describe("validateRoutine", () => {
  it("reports no issues for a valid routine with a bounded loop and fan-out/join", () => {
    expect(validateRoutine(decode(baseRoutine()))).toEqual([]);
  });

  it.each(cases)("reports $code", (testCase) => {
    const routine = baseRoutine();
    testCase.mutate(routine);
    const codes = validateRoutine(decode(routine)).map((issue) => issue.code);
    expect(codes).toContain(testCase.code);
  });
});
