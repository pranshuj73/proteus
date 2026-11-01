#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  type OrchestrationV2UserInputQuestion,
  RoutineDefinition,
  routineNewPrompt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ROUTINE_SKILLS_DESCRIPTION } from "../../apps/server/src/mcp/toolkits/routines/tools.ts";
import { validateRoutine } from "../../apps/server/src/routines/RoutineValidator.ts";
import {
  buildCouncilPrompt,
  parseCouncilReply,
} from "../../apps/server/src/routines/steps/council.ts";
import { authorCases, councilCases, skillCases } from "./cases.ts";
import {
  extractJson,
  gradeCouncil,
  gradeHumanRouting,
  gradeRoutine,
  gradeSkillProposal,
} from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-5-5" },
    out: { type: "string" },
    samples: { type: "string", default: "3" },
    case: { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const samples = Number(values.samples);
const selected = (id: string) => values.case === undefined || values.case.split(",").includes(id);

const ask = (prompt: string): string =>
  NodeChildProcess.execFileSync(
    "claude",
    ["-p", "--model", values.model, "--tools", "", "--output-format", "text"],
    { input: prompt, encoding: "utf8", timeout: 180_000, maxBuffer: 1 << 24 },
  );

const decodeDefinition = Schema.decodeUnknownOption(RoutineDefinition);
const rows: Array<{ id: string; sample: number; pass: boolean; output: string }> = [];

for (const fixture of councilCases.filter((entry) => selected(entry.id))) {
  const question: OrchestrationV2UserInputQuestion = {
    id: "q1",
    header: "Question",
    question: fixture.question,
    options: fixture.options.map((label) => ({ label, description: label })),
    multiSelect: false,
  };
  const prompt = buildCouncilPrompt({
    routineName: "Ship a change",
    brief: fixture.brief,
    stepLabel: "implement",
    stepPurpose: "Implement the change",
    earlierDecisions: [],
    earlierOutputs: [],
    questions: [question],
  });
  for (let sample = 0; sample < samples; sample += 1) {
    const output = ask(prompt);
    const parsed = parseCouncilReply(output, [question]);
    const reply =
      parsed === null
        ? null
        : { confidence: parsed.confidence, answer: JSON.stringify(parsed.answers) };
    rows.push({
      id: fixture.id,
      sample,
      pass: gradeCouncil({ reply, expect: fixture.expect }),
      output,
    });
  }
}

for (const fixture of authorCases.filter((entry) => selected(entry.id))) {
  const prompt = `${routineNewPrompt()}${fixture.useCase}\n\nNo tools are available here. Reply with only the routine JSON definition.`;
  for (let sample = 0; sample < samples; sample += 1) {
    const output = ask(prompt);
    const decoded = decodeDefinition(extractJson(output));
    const pass =
      decoded._tag === "Some" &&
      validateRoutine(decoded.value).length === 0 &&
      gradeRoutine(decoded.value, fixture.expectKinds) &&
      (fixture.expectHumanRouting !== true || gradeHumanRouting(decoded.value));
    rows.push({ id: fixture.id, sample, pass, output });
  }
}

for (const fixture of skillCases.filter((entry) => selected(entry.id))) {
  const candidate = fixture.result.found[0];
  const prompt = `You are writing a routine for a user. Tool t3_routine_skills: ${ROUTINE_SKILLS_DESCRIPTION}\n\nThe user said: ${fixture.request}\n\nThe tool returned:\n${JSON.stringify(fixture.result)}\n\nReply to the user.`;
  for (let sample = 0; sample < samples; sample += 1) {
    const output = ask(prompt);
    const pass =
      candidate !== undefined && gradeSkillProposal(output, candidate.ref, candidate.url);
    rows.push({ id: fixture.id, sample, pass, output });
  }
}

NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
const ids = [...new Set(rows.map((row) => row.id))];
const summary = ids.map((id) => {
  const own = rows.filter((row) => row.id === id);
  const passed = own.filter((row) => row.pass).length;
  return { id, passed, total: own.length, ok: passed * 2 > own.length };
});
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
