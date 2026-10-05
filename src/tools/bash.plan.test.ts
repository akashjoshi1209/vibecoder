import { describe, test, expect } from "bun:test";
import { bannedReason } from "./bash";

/** Plan mode advertises itself as read-only. These are the commands that got
 *  through when the check was a `^`-anchored regex over the raw string. */
describe("plan mode refuses state changes", () => {
  const blocked = [
    "rm -rf x",
    "rm -r x",
    "echo hi $(rm -rf x)",
    "echo hi `rm -rf x`",
    "echo hi\nrm -rf x",
    "sh -c 'rm -rf x'",
    "bash -c 'rm -rf x'",
    "find . -delete",
    "find . | xargs rm",
    "R=rm; $R -rf x",
    "mv a b",
    "git clean -fd",
    "git reset --hard",
    "git push",
    "git commit -m x",
    "git checkout -b feature",
    "git merge other",
    "git rebase main",
    "npm install left-pad",
    "npm i left-pad",
    "pip install requests",
    "apt-get install curl",
    "sudo rm -rf x",
    "echo x > f",
    "echo x | tee f",
    "truncate -s 0 f",
    "kill 1234",
    "systemctl stop nginx",
  ];
  for (const cmd of blocked) {
    test(`blocks: ${JSON.stringify(cmd)}`, () => {
      expect(bannedReason(cmd)).not.toBeNull();
    });
  }
});

describe("plan mode permits investigation", () => {
  const allowed = [
    "ls -la",
    "cat file.ts",
    "grep -r foo src/",
    "git status",
    "git log --oneline -5",
    "git diff",
    "git show HEAD",
    "git branch",
    "git remote -v",
    "git tag",
    "bun test",
    "go build ./...",
    "cargo test",
    "node script.js",
    "python3 manage.py",
    "wc -l src/*.ts",
    "echo hi > /dev/null",
  ];
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(bannedReason(cmd)).toBeNull();
    });
  }
});
