// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { RoutineDefinition } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { RoutineProcessRunner } from "../adapters/process.ts";
import { hashSkillFolder, listInstalledSkills } from "../skills.ts";
import { RoutineSkillInstaller, runSkillPreflight } from "./preflight.ts";

const definition = Schema.decodeSync(RoutineDefinition)({
  version: 1,
  name: "demo",
  steps: [{ id: "plan", kind: "skill", skill: "acme/skills@plan", verdict: { labels: ["ok"] } }],
});

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

const runner = Layer.succeed(RoutineProcessRunner)({
  run: (input) =>
    Effect.sync(() => {
      try {
        const out = NodeChildProcess.execFileSync(input.argv[0]!, input.argv.slice(1), {
          cwd: input.cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
          },
        });
        return { code: 0, output: out, timedOut: false };
      } catch (error) {
        return { code: 1, output: String(error), timedOut: false };
      }
    }),
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  git(root, "init", "-q");
  yield* fs.writeFileString(`${root}/README.md`, "x");
  git(root, "add", ".");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return root;
});

const fakeInstaller = Layer.succeed(RoutineSkillInstaller)({
  install: ({ cwd, name }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${cwd}/.agents/skills/${name}`, { recursive: true });
      yield* fs.writeFileString(
        `${cwd}/.agents/skills/${name}/SKILL.md`,
        `---\nname: ${name}\ndescription: Plans\n---\nbody`,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
});

const env = Layer.mergeAll(NodeServices.layer, runner, fakeInstaller);

it.effect("installs a locked skill, links it and commits it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* setup;
    yield* fs.writeFileString(
      `${root}/skills-lock.json`,
      JSON.stringify({ skills: { plan: { source: "acme/skills" } } }),
    );
    const hashes = yield* runSkillPreflight({
      worktreePath: root,
      definition,
      providers: ["claudeAgent"],
    });
    assert.strictEqual(hashes.size, 1);
    assert.isTrue(yield* fs.exists(`${root}/.claude/skills/plan/SKILL.md`));
    assert.match(git(root, "log", "-1", "--format=%s"), /install skills/);
    assert.strictEqual(git(root, "status", "--porcelain").trim(), "");
    assert.deepStrictEqual(
      (yield* listInstalledSkills(root)).map((s) => s.description),
      ["Plans"],
    );
  }).pipe(Effect.scoped, Effect.provide(env)),
);

it.effect("aborts on a hash mismatch and on an unpinned remote skill", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* setup;
    const unpinned = yield* Effect.flip(
      runSkillPreflight({ worktreePath: root, definition, providers: [] }),
    );
    assert.match(unpinned.message, /not pinned/);

    yield* fs.makeDirectory(path.join(root, ".agents/skills/plan"), { recursive: true });
    yield* fs.writeFileString(`${root}/.agents/skills/plan/SKILL.md`, "---\nname: plan\n---\n");
    const expected = yield* hashSkillFolder(`${root}/.agents/skills/plan`);
    yield* fs.writeFileString(
      `${root}/skills-lock.json`,
      JSON.stringify({ skills: { plan: { source: "acme/skills", computedHash: expected } } }),
    );
    yield* fs.writeFileString(`${root}/.agents/skills/plan/SKILL.md`, "tampered");
    const drift = yield* Effect.flip(
      runSkillPreflight({ worktreePath: root, definition, providers: [] }),
    );
    assert.match(drift.message, /locked hash/);
  }).pipe(Effect.scoped, Effect.provide(env)),
);
