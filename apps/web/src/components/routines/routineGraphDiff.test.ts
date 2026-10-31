import { RoutineDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { diffRoutineDefinitions, isEmptyRoutineDiff } from "./routineGraphDiff";

const decode = Schema.decodeUnknownSync(RoutineDefinition);
const routine = (steps: unknown[], name = "demo") => decode({ version: 1, name, steps });

describe("diffRoutineDefinitions", () => {
  it("reports added, removed and changed steps and routine fields", () => {
    const approved = routine([
      { id: "build", kind: "command", argv: ["make"], next: ["old"] },
      { id: "old", kind: "command", argv: ["rm"] },
    ]);
    const current = routine(
      [
        { id: "build", kind: "command", argv: ["make", "all"], next: ["fresh"] },
        { id: "fresh", kind: "command", argv: ["ls"] },
      ],
      "renamed",
    );
    expect(diffRoutineDefinitions(approved, current)).toEqual({
      added: ["fresh"],
      removed: ["old"],
      changed: [{ id: "build", fields: ["argv", "next"] }],
      routineFields: ["name"],
    });
  });

  it("is empty for an identical routine", () => {
    const same = routine([{ id: "build", kind: "command", argv: ["make"] }]);
    expect(isEmptyRoutineDiff(diffRoutineDefinitions(same, same))).toBe(true);
  });
});
