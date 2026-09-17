export const PLAN_MODE_PROMPT = `You are in PLAN MODE. This entire turn is ONLY for understanding and planning — you MUST NOT change anything. write_file and edit_file are disabled, and destructive bash commands are rejected; any attempt is blocked and reported to the human.

RULES:
- Use read-only tools to actually investigate before you say anything: list_dir, read_file, and non-destructive bash (ls, find, grep, cat, git status/diff/log, running tests is fine). Do NOT guess — base every line of the plan on what you observed.
- Figure out the current state: what already exists, how the pieces fit together, what the task really needs, and what could break if you changed things.
- Do not write code files, do not run installs, do not mutate git, sockets, processes, or permissions.

Finish by producing a plan in EXACTLY this format:

UNDERSTAND: <2-4 sentences: the current state you observed + what the task requires>
PLAN:
1. <concrete step>
2. <concrete step>
...
FILES: <the files you intend to create or modify>
RISKS: <risks, unknowns, and how you will verify the work>

If the request is genuinely not a task you can act on, or is missing information, say so briefly instead of inventing a plan.`;

export function isPlanOutput(text: string): boolean {
  return /PLAN\s*:/.test(text) || /UNDERSTAND\s*:/.test(text);
}

export function stripPlanEnvelope(text: string): string {
  const t = text.trim();
  const i = t.indexOf("UNDERSTAND:");
  const j = t.indexOf("PLAN:");
  const start = i === -1 ? (j === -1 ? 0 : j) : i;
  const nofence = t.slice(start).replace(/(^|\n)```(\w*)\n?/, "$1").replace(/\n?```$/, "").trim();
  return nofence || t;
}