import { assert, it } from "@effect/vitest";

import { parseSkillSearch } from "./skills.ts";

const output = [
  "\u001b[38;5;102mInstall with\u001b[0m npx skills add <owner/repo@skill>",
  "",
  "\u001b[38;5;145mvercel-labs/agent-skills@react-rules\u001b[0m \u001b[36m1.2M installs\u001b[0m",
  "\u001b[38;5;102m└ https://skills.sh/vercel-labs/agent-skills/react-rules\u001b[0m",
  "",
  "\u001b[38;5;145mopen.feishu.cn@lark-event\u001b[0m \u001b[36m835.4K installs\u001b[0m",
  "",
  "\u001b[38;5;145macme/skills@solo\u001b[0m \u001b[36m1 install\u001b[0m",
  "\u001b[38;5;145macme/skills@cut\u001b[0m \u001b[36m9",
].join("\n");

it("parses search results with their trust signals", () => {
  const found = parseSkillSearch(output, {
    installedNames: new Set(["solo"]),
    lockedSources: new Set(["vercel-labs/agent-skills"]),
  });
  assert.deepStrictEqual(found, [
    {
      ref: "vercel-labs/agent-skills@react-rules",
      source: "vercel-labs/agent-skills",
      name: "react-rules",
      installs: 1_200_000,
      url: "https://skills.sh/vercel-labs/agent-skills/react-rules",
      installed: false,
      sourceInLock: true,
    },
    {
      ref: "open.feishu.cn@lark-event",
      source: "open.feishu.cn",
      name: "lark-event",
      installs: 835_400,
      url: null,
      installed: false,
      sourceInLock: false,
    },
    {
      ref: "acme/skills@solo",
      source: "acme/skills",
      name: "solo",
      installs: 1,
      url: null,
      installed: true,
      sourceInLock: false,
    },
  ]);
});
