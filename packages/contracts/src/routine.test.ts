import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { RoutineDefinition, RoutineStep, routineStepVerdictLabels } from "./routine.ts";

const decodeDefinition = Schema.decodeUnknownSync(RoutineDefinition);
const decodeStep = Schema.decodeUnknownSync(RoutineStep);

const validRoutine = {
  version: 1,
  name: "Ship it",
  steps: [
    {
      id: "plan",
      kind: "skill",
      skill: "core/plan@v1",
      verdict: { labels: ["ready", "blocked"] },
      on: { ready: "build", blocked: "$end" },
    },
    {
      id: "review",
      kind: "agent",
      purpose: "Review the plan",
      verdict: { labels: ["approve", "reject"] },
    },
    { id: "build", kind: "command", argv: ["bun", "run", "build"] },
    { id: "ship", kind: "action", action: "git.push", draft: false },
  ],
};

describe("RoutineDefinition", () => {
  it("decodes a routine using all four step kinds", () => {
    const decoded = decodeDefinition(validRoutine);
    expect(decoded.steps.map((step) => step.kind)).toEqual(["skill", "agent", "command", "action"]);
  });

  it("rejects an unknown step kind", () => {
    expect(() =>
      decodeDefinition({
        version: 1,
        name: "Bad kind",
        steps: [{ id: "deploy", kind: "deploy", argv: ["ls"] }],
      }),
    ).toThrow();
  });

  it("rejects a non-kebab step id", () => {
    expect(() =>
      decodeDefinition({
        version: 1,
        name: "Bad id",
        steps: [{ id: "Plan Step", kind: "command", argv: ["ls"] }],
      }),
    ).toThrow();
  });
});

describe("routineStepVerdictLabels", () => {
  it("uses the implicit pass/fail labels for command steps", () => {
    const command = decodeStep({ id: "build", kind: "command", argv: ["bun", "test"] });
    expect(routineStepVerdictLabels(command)).toEqual(["pass", "fail"]);
  });

  it("uses the implicit created/failed labels for action steps", () => {
    const action = decodeStep({ id: "ship", kind: "action", action: "pr.create" });
    expect(routineStepVerdictLabels(action)).toEqual(["created", "failed"]);
  });

  it("uses the declared labels for skill and agent steps", () => {
    const skill = decodeStep({
      id: "plan",
      kind: "skill",
      skill: "plan",
      verdict: { labels: ["ready", "blocked"] },
    });
    expect(routineStepVerdictLabels(skill)).toEqual(["ready", "blocked"]);
  });
});
