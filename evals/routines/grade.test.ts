import { expect, it } from "@effect/vitest";

import { extractJson, gradeCouncil } from "./grade.ts";

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
