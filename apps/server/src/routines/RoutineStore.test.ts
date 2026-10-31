import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProjectId, RoutineDefinition, type RoutineId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { canonicalRoutineText, list, routineHash, writeCanonical } from "./RoutineStore.ts";

const decode = Schema.decodeUnknownSync(RoutineDefinition);

// Branded ids are plain strings at runtime; the store never relies on the brand.
const projectId = "demo-project" as ProjectId;
const routineId = "demo" as RoutineId;

const baseRoutine = () =>
  decode({
    version: 1,
    name: "demo",
    start: "plan",
    steps: [
      {
        id: "plan",
        kind: "agent",
        purpose: "plan the work",
        verdict: { labels: ["ready"] },
        next: ["impl"],
      },
      { id: "impl", kind: "command", argv: ["echo", "go"] },
    ],
  });

describe("RoutineStore canonical serialization", () => {
  it("is idempotent across a JSON round-trip", () => {
    const def = baseRoutine();
    const once = canonicalRoutineText(def);
    const twice = canonicalRoutineText(JSON.parse(once) as RoutineDefinition);
    expect(twice).toBe(once);
  });

  it("emits keys in the specified order", () => {
    const def = decode({
      version: 1,
      name: "rich",
      description: "desc",
      council: { provider: "claude", model: "opus" },
      start: "s1",
      steps: [
        {
          id: "s1",
          title: "Step one",
          kind: "agent",
          purpose: "do",
          verdict: { labels: ["b", "a"] },
          inputs: [],
          on: { a: "$end", b: "s1" },
          maxIterations: 2,
          timeoutMs: 1000,
          retries: 1,
        },
      ],
    });
    const parsed = JSON.parse(canonicalRoutineText(def));
    expect(Object.keys(parsed)).toEqual([
      "version",
      "name",
      "description",
      "council",
      "start",
      "steps",
    ]);
    expect(Object.keys(parsed.council)).toEqual(["provider", "model"]);
    expect(Object.keys(parsed.steps[0])).toEqual([
      "id",
      "title",
      "kind",
      "purpose",
      "verdict",
      "inputs",
      "on",
      "maxIterations",
      "timeoutMs",
      "retries",
    ]);
    expect(Object.keys(parsed.steps[0].on)).toEqual(["b", "a"]);
  });
});

it.layer(NodeServices.layer)("RoutineStore filesystem", (it) => {
  it.effect("returns an empty list when the routines directory is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-routines-" });
      expect(yield* list({ workspaceRoot: root, projectId })).toEqual([]);
    }),
  );

  it.effect("summarizes an invalid JSON file with an invalid-json issue and null definition", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-routines-" });
      const directory = path.join(root, ".proteus", "routines");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(directory, "broken.json"), "{ not json ");

      const routines = yield* list({ workspaceRoot: root, projectId });
      expect(routines).toHaveLength(1);
      expect(routines[0]!.definition).toBeNull();
      expect(routines[0]!.hash).toBeNull();
      expect(routines[0]!.issues.map((issue) => issue.code)).toContain("invalid-json");
    }),
  );

  it.effect("writeCanonical persists text that list reads back without issues", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-routines-" });
      const def = baseRoutine();
      yield* writeCanonical({ workspaceRoot: root, definition: def, id: routineId });

      const routines = yield* list({ workspaceRoot: root, projectId });
      expect(routines).toHaveLength(1);
      expect(routines[0]!.id).toBe("demo");
      expect(routines[0]!.issues).toEqual([]);
      expect(routines[0]!.hash).toBe(routineHash(canonicalRoutineText(def)));
    }),
  );
});
