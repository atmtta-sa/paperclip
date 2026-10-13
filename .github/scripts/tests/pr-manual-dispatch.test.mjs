import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const caller = readFileSync(new URL("../../workflows/pr.yml", import.meta.url), "utf8");
const reusable = readFileSync(
  new URL("../../workflows/pr-trusted.yml", import.meta.url),
  "utf8",
);

test("PR CI exposes an exact-head manual fallback", () => {
  assert.match(caller, /^  workflow_dispatch:/m);
  assert.match(caller, /^      pr_number:/m);
  assert.match(caller, /^      head_sha:/m);
  assert.match(caller, /^  resolve_pr:/m);
  assert.match(caller, /\.state == "open"/);
  assert.match(caller, /\.head\.sha == \$head_sha/);
  assert.match(caller, /\.head\.repo\.id == \.base\.repo\.id/);
  assert.match(caller, /uses: \.\/\.github\/workflows\/pr-trusted\.yml/);
});

test("trusted PR CI consumes only validated caller metadata", () => {
  for (const input of [
    "pr_number",
    "head_sha",
    "head_ref",
    "base_sha",
    "base_ref",
    "author_login",
  ]) {
    assert.match(reusable, new RegExp(`^      ${input}:$`, "m"));
    assert.match(caller, new RegExp(`^      ${input}: \\\${{ needs\\.resolve_pr\\.outputs\\.${input} }}$`, "m"));
  }
  assert.doesNotMatch(reusable, /github\.event\.pull_request/);
  assert.doesNotMatch(reusable, /github\.head_ref/);
});

test("every CI checkout uses the validated PR head", () => {
  const checkoutCount = (reusable.match(/uses: actions\/checkout@/g) ?? []).length;
  const exactRefCount = (
    reusable.match(/ref: \$\{\{ inputs\.head_sha \}\}/g) ?? []
  ).length;

  assert.ok(checkoutCount > 0);
  assert.equal(exactRefCount, checkoutCount);
});

test("stack metadata uses multiline workflow output syntax", () => {
  assert.match(caller, /echo "stack_json<<PR_STACK_JSON"/);
  assert.match(caller, /echo "PR_STACK_JSON"/);
  assert.doesNotMatch(caller, /echo "stack_json=\$EVENT_STACK_JSON"/);
});
