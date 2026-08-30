import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMPADRE_SKILL_NAMES = [
  "query-database",
  "pull-request",
  "integration-debugging",
  "dev-environment",
] as const;

export type CompadreSkillName = (typeof COMPADRE_SKILL_NAMES)[number];

const COMPADRE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SANDBOX_SKILLS_DIRECTORY = "/opt/compadre-skills";

export function sandboxCompadreSkillPath(
  skill: CompadreSkillName,
): string {
  return path.posix.join(
    SANDBOX_SKILLS_DIRECTORY,
    skill,
    "SKILL.md",
  );
}

/** Materialize Compadre-owned operating guides inside a harness workspace. */
export function compadreSkillUploads(): Array<{ path: string; data: Uint8Array }> {
  return COMPADRE_SKILL_NAMES.map((skill) => ({
    path: sandboxCompadreSkillPath(skill),
    data: fs.readFileSync(
      path.join(COMPADRE_ROOT, "skills", skill, "SKILL.md"),
    ),
  }));
}
