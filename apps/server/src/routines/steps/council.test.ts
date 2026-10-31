import { assert, it } from "@effect/vitest";
import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

import { parseCouncilReply } from "./council.ts";

const questions: ReadonlyArray<OrchestrationV2UserInputQuestion> = [
  { id: "a", header: "A", question: "Pick", options: [] },
  { id: "b", header: "B", question: "Pick many", options: [], multiSelect: true },
];

it("parses the trailing COUNCIL line and defaults unknown confidence to low", () => {
  const reply = parseCouncilReply(
    'notes\nCOUNCIL: {"answers":{"a":" x ","b":["y","z"]},"rationale":"why","confidence":"sure"}',
    questions,
  );
  assert.deepEqual(reply, {
    answers: { a: "x", b: ["y", "z"] },
    rationale: "why",
    confidence: "low",
  });
});

it("rejects a reply that leaves a question unanswered or is not JSON", () => {
  assert.equal(
    parseCouncilReply('COUNCIL: {"answers":{"a":"x"},"confidence":"high"}', questions),
    null,
  );
  assert.equal(parseCouncilReply("COUNCIL: {nope}", questions), null);
  assert.equal(parseCouncilReply("no line", questions), null);
});
