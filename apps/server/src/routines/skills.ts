import type { RoutineDefinition } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const SKILLS_DIR = ".agents/skills";
export const SKILLS_LOCK = "skills-lock.json";

/** Provider skill directories that need a link to the shared `.agents/skills` copy. */
const PROVIDER_SKILL_DIRS: Readonly<Record<string, string>> = {
  claudeAgent: ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".opencode/skills",
};

export interface SkillRef {
  /** `owner/repo` for a remote skill; undefined for a plain local name. */
  readonly source: string | undefined;
  readonly name: string;
}

/** Parses `source@name` or a plain `name`. */
const parseSkillRef = (ref: string): SkillRef => {
  const at = ref.lastIndexOf("@");
  return at < 0
    ? { source: undefined, name: ref }
    : { source: ref.slice(0, at), name: ref.slice(at + 1) };
};

export const referencedSkills = (definition: RoutineDefinition): ReadonlyArray<SkillRef> => {
  const seen = new Map<string, SkillRef>();
  for (const step of definition.steps) {
    if (step.kind !== "skill") continue;
    const ref = parseSkillRef(step.skill);
    seen.set(`${ref.source ?? ""}@${ref.name}`, ref);
  }
  return [...seen.values()];
};

const LockFile = Schema.Struct({
  skills: Schema.Record(
    Schema.String,
    Schema.Struct({
      source: Schema.optional(Schema.String),
      computedHash: Schema.optional(Schema.String),
    }),
  ),
});
const decodeLock = Schema.decodeUnknownOption(Schema.fromJsonString(LockFile));

export interface SkillPin {
  readonly source: string | undefined;
  readonly hash: string | undefined;
}

/** Reads skills-lock.json pins; a missing or malformed lock yields no pins. */
export const readLock = Effect.fn("RoutineSkills.readLock")(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(workspaceRoot, SKILLS_LOCK);
  const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const decoded = decodeLock(text);
  const pins = new Map<string, SkillPin>();
  if (decoded._tag === "Some") {
    for (const [name, entry] of Object.entries(decoded.value.skills)) {
      pins.set(name, { source: entry.source, hash: entry.computedHash });
    }
  }
  return pins;
});

const listFilesSorted = Effect.fn("RoutineSkills.listFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs.readDirectory(dir, { recursive: true });
  return [...entries].toSorted();
});

/** Content hash of a skill folder: relative paths and file bytes, in sorted order. */
export const hashSkillFolder = Effect.fn("RoutineSkills.hashFolder")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const encoder = new TextEncoder();
  const chunks: Array<Uint8Array> = [];
  for (const relative of yield* listFilesSorted(dir)) {
    const info = yield* fs.stat(path.join(dir, relative));
    if (info.type !== "File") continue;
    chunks.push(encoder.encode(`${relative}\0`), yield* fs.readFile(path.join(dir, relative)));
    chunks.push(encoder.encode("\0"));
  }
  const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = yield* crypto.digest("SHA-256", data);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

export interface InstalledSkill {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

const frontmatterField = (text: string, field: string): string | undefined => {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  const line = match?.[1]?.split("\n").find((entry) => entry.startsWith(`${field}:`));
  const value = line?.slice(field.length + 1).trim();
  return value === undefined || value.length === 0 ? undefined : value.replace(/^["']|["']$/g, "");
};

/** Catalog of skills installed under `.agents/skills` (project scope). */
export const listInstalledSkills = Effect.fn("RoutineSkills.listInstalled")(function* (
  workspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspaceRoot, SKILLS_DIR);
  const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
  const skills: Array<InstalledSkill> = [];
  for (const name of [...names].toSorted()) {
    const dir = path.join(root, name);
    const text = yield* fs
      .readFileString(path.join(dir, "SKILL.md"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) continue;
    skills.push({
      name: frontmatterField(text, "name") ?? name,
      description: frontmatterField(text, "description") ?? "",
      path: `${SKILLS_DIR}/${name}`,
    });
  }
  return skills;
});

/** Provider skill dirs for the providers in use; `.agents/skills` itself needs no link. */
export const providerSkillDirs = (providers: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    providers.flatMap((provider) => {
      const dir = PROVIDER_SKILL_DIRS[provider];
      return dir === undefined ? [] : [dir];
    }),
  ),
];

/** Links `<providerDir>/<name>` to the shared copy; copies when symlinks are unavailable. */
export const linkSkill = Effect.fn("RoutineSkills.link")(function* (input: {
  readonly workspaceRoot: string;
  readonly providerDir: string;
  readonly name: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(input.workspaceRoot, SKILLS_DIR, input.name);
  const link = path.join(input.workspaceRoot, input.providerDir, input.name);
  yield* fs.makeDirectory(path.dirname(link), { recursive: true });
  if (yield* fs.exists(link)) return "present" as const;
  const symlinked = yield* fs.symlink(path.relative(path.dirname(link), target), link).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (symlinked) return "symlink" as const;
  yield* fs.copy(target, link);
  return "copy" as const;
});

/** A link is healthy when its `SKILL.md` is readable through it. */
export const isLinkHealthy = Effect.fn("RoutineSkills.isLinkHealthy")(function* (
  workspaceRoot: string,
  providerDir: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .exists(path.join(workspaceRoot, providerDir, name, "SKILL.md"))
    .pipe(Effect.orElseSucceed(() => false));
});
