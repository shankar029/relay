import test from "node:test";
import assert from "node:assert/strict";
import { bashConfinementProblem as b } from "../lib/policy.mjs";

test("bash confinement blocks writes outside the worktree", () => {
  const cwd = process.platform === "win32" ? "C:\\w\\repo" : "/w/repo";
  const out = process.platform === "win32" ? "C:\\x\\o.txt" : "/x/o.txt";
  for (const c of ["echo x > ../outside.txt", `echo x >> ${out}`, "cat a | tee ../o.txt", "cp a.txt ../b.txt", "rm -rf ../x", "echo hi > ~/f", `Set-Content ${out} hi`])
    assert.ok(b(c, cwd), c);
});

test("bash confinement allows in-tree writes and sinks", () => {
  const cwd = "/w/repo";
  for (const c of ["echo x > src/a.txt", "npm test 2>&1 | tee out.log", "node a.js > /dev/null 2>&1", "cp a.js src/b.js", "git status"])
    assert.equal(b(c, cwd), null, c);
});