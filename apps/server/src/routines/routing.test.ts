import { RoutineDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { nextSteps } from "./routing.ts";

const decode = Schema.decodeUnknownSync(RoutineDefinition);

const definition = decode({
  version: 1,
  name: "routing",
  steps: [
    { id: "build", kind: "command", argv: ["make"], next: ["review"] },
    {
      id: "review",
      kind: "agent",
      purpose: "review the change",
      verdict: { labels: ["approved", "changes"] },
      on: { approved: "$end", changes: "fix" },
    },
    { id: "fix", kind: "command", argv: ["make", "fix"] },
  ],
});

const stepId = (id: string) => definition.steps.find((step) => step.id === id)!.id;

describe("routing.nextSteps", () => {
  it("follows next regardless of the verdict", () => {
    expect(nextSteps(definition, stepId("build"), "fail")).toEqual(["review"]);
  });

  it.each([
    ["changes", ["fix"]],
    ["approved", []],
    ["unknown", []],
  ])("routes the %s verdict through on", (label, expected) => {
    expect(nextSteps(definition, stepId("review"), label)).toEqual(expected);
  });

  it("returns no successors at a terminal step", () => {
    expect(nextSteps(definition, stepId("fix"), "pass")).toEqual([]);
  });
});
