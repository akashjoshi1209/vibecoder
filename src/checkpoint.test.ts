// Tests for checkpoint creation, drift detection, and the git-free path.
//
// Uses a real temp git repo because the interesting behaviour IS the interaction
// with git: `git stash create` is the whole reason a checkpoint does not disturb
// the user's refs. A mock would prove nothing about that.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCheckpoint,
  deleteCheckpoint,
  diffAgainstCheckpoint,
  getCheckpoint,
  indexPath,
  isGitRepo,
  listCheckpoints,
  restoreCheckpoint,
} from "./checkpoint";

const dataRoot = mkdtempSync(join(tmpdir(), "vc-cp-data-"));
const repo = mkdtempSync(join(tmpdir(), "vc-cp-repo-"));
const plain = mkdtempSync(join(tmpdir(), "vc-cp-plain-"));
const priorRoot = process.env.VIBECODER_SESSION_DIR;

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
}

beforeAll(() => {
  process.env.VIBECODER_SESSION_DIR = dataRoot;
  git(["init", "-q"]);
  git(["config", "user.email", "t@e"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-qm", "init"]);
});

afterAll(() => {
  if (priorRoot === undefined) delete process.env.VIBECODER_SESSION_DIR;
  else process.env.VIBECODER_SESSION_DIR = priorRoot;
  for (const d of [dataRoot, repo, plain]) rmSync(d, { recursive: true, force: true });
});

function resetWorktree(): void {
  // `git reset` first: an earlier test that stages a file leaves it staged, and
  // `checkout -- .` alone does not clear the index — so the next "clean tree"
  // checkpoint would find a dirty tree and the test would fail for a reason that
  // has nothing to do with checkpoints.
  git(["reset", "-q"]);
  git(["checkout", "-q", "--", "."]);
  git(["clean", "-qfd"]);
}

describe("isGitRepo", () => {
  test("true inside a work tree", async () => {
    expect(await isGitRepo(repo)).toBe(true);
  });
  test("false outside one", async () => {
    expect(await isGitRepo(plain)).toBe(false);
  });
});

describe("createCheckpoint", () => {
  test("leaves HEAD, the index and refs untouched", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    const headBefore = git(["rev-parse", "HEAD"]).trim();
    const statusBefore = git(["status", "--porcelain"]);
    const stashBefore = git(["stash", "list"]).trim();

    const cp = await createCheckpoint({ sessionId: "s1", cwd: repo, label: "before big edit" });
    expect(cp.gitSha).toBeTruthy();

    // This is the property that makes `git stash create` the right primitive
    // rather than `git stash push`: a checkpoint must not move the user's
    // repository at all.
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(["status", "--porcelain"])).toBe(statusBefore);
    expect(git(["stash", "list"]).trim()).toBe(stashBefore);
  });

  test("does not leave entries to clean up in git stash list", async () => {
    await createCheckpoint({ sessionId: "s1", cwd: repo });
    // Every checkpoint creates an object; none of them should accumulate a
    // stash entry the user has to remember to drop.
    expect(git(["stash", "list"]).trim()).toBe("");
  });

  test("records the dirty files with content hashes", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "v2\n");
    writeFileSync(join(repo, "brand-new.txt"), "fresh\n");
    const cp = await createCheckpoint({ sessionId: "s2", cwd: repo });
    const paths = cp.files.map((f) => f.path.replace(/\\/g, "/")).sort();
    expect(paths.some((p) => p.endsWith("/tracked.txt"))).toBe(true);
    // Untracked files count too — they are exactly the ones a naive snapshot
    // would miss and a later "clean up" would delete.
    expect(paths.some((p) => p.endsWith("/brand-new.txt"))).toBe(true);
    expect(cp.alreadyDirty).toBe(true);
    for (const f of cp.files) expect(f.sha).not.toBe("");
  });

  test("handles paths containing spaces", async () => {
    resetWorktree();
    writeFileSync(join(repo, "a file with spaces.txt"), "x\n");
    const cp = await createCheckpoint({ sessionId: "s3", cwd: repo });
    // --porcelain -z keeps the path intact; a whitespace split would truncate it.
    expect(cp.files.some((f) => f.path.endsWith("a file with spaces.txt"))).toBe(true);
  });

  test("a clean tree yields no git object but still records", async () => {
    resetWorktree();
    const cp = await createCheckpoint({ sessionId: "s4", cwd: repo });
    expect(cp.files.length).toBe(0);
    // `git stash create` prints nothing when there is nothing to stash. That is
    // not a failure and must not be reported as one.
    expect(cp.gitSha).toBeNull();
  });

  test("scans the filesystem when there is no repo", async () => {
    writeFileSync(join(plain, "loose.txt"), "x\n");
    const cp = await createCheckpoint({ sessionId: "s5", cwd: plain });
    expect(cp.gitSha).toBeNull();
    // Not zero. A checkpoint that records nothing and then reports a successful
    // restore would be the worst kind of broken.
    expect(cp.files.length).toBeGreaterThan(0);
    expect(cp.files.every((f) => f.untracked)).toBe(true);
    // And the content must actually be stashed, since no git object exists.
    expect(cp.files.some((f) => f.blob)).toBe(true);
  });
});

describe("diffAgainstCheckpoint", () => {
  test("clean when nothing moved", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "x\n");
    const cp = await createCheckpoint({ sessionId: "s6", cwd: repo });
    expect(diffAgainstCheckpoint(cp).clean).toBe(true);
  });

  test("detects a changed file", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "x\n");
    const cp = await createCheckpoint({ sessionId: "s7", cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "y\n");
    const d = diffAgainstCheckpoint(cp);
    expect(d.clean).toBe(false);
    expect(d.drifted.length).toBe(1);
    expect(d.drifted[0]).toContain("tracked.txt");
  });

  test("reports added and removed separately from drifted", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "x\n");
    const cp = await createCheckpoint({ sessionId: "s8", cwd: repo });
    rmSync(join(repo, "tracked.txt"));
    writeFileSync(join(repo, "new-thing.txt"), "n\n");
    const d = diffAgainstCheckpoint(cp);
    expect(d.removed.some((p) => p.endsWith("tracked.txt"))).toBe(true);
    expect(d.added.some((p) => p.endsWith("new-thing.txt"))).toBe(true);
  });
});

describe("restoreCheckpoint", () => {
  test("restores tracked files, which is the case stash apply refuses", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "checkpoint-state\n");
    const cp = await createCheckpoint({ sessionId: "s9", cwd: repo });
    // A change made through bash, which the change log never sees. This also
    // leaves the tree dirty, which is exactly when `git stash apply` bails out
    // with "local changes would be overwritten" — i.e. the only time a restore
    // is actually wanted.
    writeFileSync(join(repo, "tracked.txt"), "later-state\n");
    const res = await restoreCheckpoint(cp);
    expect(res.ok).toBe(true);
    // Compared on content, not bytes: git's autocrlf normalizes to CRLF on
    // checkout on Windows, which is a property of the platform, not of the
    // checkpoint. Asserting exact bytes here would fail for that reason alone.
    expect(readFileSync(join(repo, "tracked.txt"), "utf8").trim()).toBe("checkpoint-state");
  });

  test("restores untracked files, which `git stash create` never captures", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "t\n");
    writeFileSync(join(repo, "agent-made.ts"), "created by the agent\n");
    const cp = await createCheckpoint({ sessionId: "s11", cwd: repo });
    // `git stash create` has no -u, so the object alone would not contain this.
    expect(cp.gitSha).toBeTruthy();
    const res = await restoreCheckpoint(cp);
    expect(res.ok).toBe(true);
    if (res.ok) expect(readFileSync(join(repo, "agent-made.ts"), "utf8")).toBe("created by the agent\n");
  });

  test("restores an untracked file the agent overwrote", async () => {
    resetWorktree();
    writeFileSync(join(repo, "scratch.txt"), "original scratch\n");
    const cp = await createCheckpoint({ sessionId: "s12", cwd: repo });
    writeFileSync(join(repo, "scratch.txt"), "clobbered\n");
    const res = await restoreCheckpoint(cp);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("original scratch\n");
  });

  test("leaves HEAD and unrelated files alone", async () => {
    resetWorktree();
    writeFileSync(join(repo, "tracked.txt"), "cp\n");
    const headBefore = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "tracked.txt"), "later\n");
    writeFileSync(join(repo, "untouched-by-cp.txt"), "keep me\n");
    git(["add", "untouched-by-cp.txt"]);
    const cp = await createCheckpoint({ sessionId: "s13", cwd: repo });
    // Now make it dirty again so a restore has something to do.
    writeFileSync(join(repo, "tracked.txt"), "latest\n");
    const res = await restoreCheckpoint(cp);
    expect(res.ok).toBe(true);
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(readFileSync(join(repo, "untouched-by-cp.txt"), "utf8")).toBe("keep me\n");
  });

  test("a checkpoint of nothing is a no-op, not a failure", async () => {
    resetWorktree();
    const cp = await createCheckpoint({ sessionId: "s14", cwd: repo });
    const res = await restoreCheckpoint(cp);
    // Restoring over a clean tree is a legitimate "already there", which is what
    // the drift check in /restore normally catches before we get here.
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.restored.length).toBe(0);
  });

  test("restores without git at all, from its own blob store", async () => {
    const f = join(plain, "no-git-here.txt");
    writeFileSync(f, "created outside any repo\n");
    const cp = await createCheckpoint({ sessionId: "s10", cwd: plain });
    // No git object, yet the restore still works — this is why the blob store
    // exists rather than relying on the stash object alone.
    expect(cp.gitSha).toBeNull();
    expect(cp.files.length).toBeGreaterThan(0);
    writeFileSync(f, "changed\n");
    const res = await restoreCheckpoint(cp);
    expect(res.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("created outside any repo\n");
  });

  test("an empty checkpoint restores to nothing without failing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "vc-cp-empty-"));
    try {
      const cp = await createCheckpoint({ sessionId: "s15", cwd: empty });
      const res = await restoreCheckpoint(cp);
      // Restoring an empty checkpoint is a legitimate no-op, not an error the
      // user has to interpret.
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.restored.length).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("checkpoint index", () => {
  test("lists, finds and forgets checkpoints", async () => {
    const a = await createCheckpoint({ sessionId: "idx", cwd: repo, label: "one" });
    const b = await createCheckpoint({ sessionId: "idx", cwd: repo, label: "two" });
    expect(listCheckpoints("idx").length).toBeGreaterThanOrEqual(2);
    expect(getCheckpoint(b.id, "idx")?.label).toBe("two");
    expect(deleteCheckpoint(b.id, "idx")).toBe(true);
    expect(getCheckpoint(b.id, "idx")).toBeNull();
    expect(getCheckpoint(a.id, "idx")?.label).toBe("one");
  });

  test("ids are never reused after an entry is dropped", async () => {
    const c1 = await createCheckpoint({ sessionId: "u", cwd: repo });
    deleteCheckpoint(c1.id);
    const c2 = await createCheckpoint({ sessionId: "u", cwd: repo });
    // Deriving the id from the entry count would hand back c1's number here, and
    // a transcript mentioning "restore 13" would then mean something different
    // than it did before.
    expect(c2.id).not.toBe(c1.id);
    expect(Number(c2.id)).toBeGreaterThan(Number(c1.id));
  });

  test("an unqualified id still resolves after a session switch", async () => {
    const cp = await createCheckpoint({ sessionId: "session-x", cwd: repo });
    expect(getCheckpoint(cp.id, "session-y")?.id).toBe(cp.id);
  });

  test("indexPath points inside the redirected data root", () => {
    // Guards against the store escaping the test's VIBECODER_SESSION_DIR and
    // writing into the developer's real ~/.vibecoder.
    expect(indexPath().startsWith(dataRoot)).toBe(true);
  });
});