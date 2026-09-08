import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeRedirectPath, DEFAULT_REDIRECT } from "../src/lib/safeRedirect";

test("an ordinary same-origin path passes through untouched", () => {
  for (const p of ["/dashboard", "/map", "/data/permits/12", "/top25?sort=score", "/test-address#result"])
    assert.equal(safeRedirectPath(p), p);
});

test("the userinfo trick is rejected", () => {
  // `${origin}${next}` with "@evil.com" yields https://site.com@evil.com, whose
  // host is evil.com — site.com is parsed as userinfo. This was the finding.
  for (const p of ["@evil.com", "@evil.com/steal", "evil.com", ".evil.com"])
    assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT, p);
});

test("protocol-relative and absolute URLs are rejected", () => {
  for (const p of ["//evil.com", "///evil.com", "https://evil.com", "http://evil.com", "//evil.com/dashboard"])
    assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT, p);
});

test("backslashes are normalized before the check, not after", () => {
  // browsers resolve "\" as "/", so "\\evil.com" would otherwise slip past a
  // naive startsWith("//") check and then resolve off-site
  for (const p of ["\\\\evil.com", "/\\evil.com", "\\/evil.com"])
    assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT, JSON.stringify(p));
  // a single leading backslash is same-origin once normalized, so it is allowed
  assert.equal(safeRedirectPath("\\evil.com"), "/evil.com");
});

test("scheme-bearing paths are rejected", () => {
  for (const p of ["/javascript:alert(1)", "/data:text/html,x", "//javascript:alert(1)"])
    assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT, p);
});

test("control characters are rejected rather than stripped", () => {
  for (const p of ["/dash\nboard", "/dash\rboard", "/dash\tboard", "/dash\x00board", "/dash\x7fboard"])
    assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT, JSON.stringify(p));
});

test("a space is not a control character; new URL percent-encodes it safely", () => {
  assert.equal(safeRedirectPath("/dash board"), "/dash board");
});

test("empty, whitespace, and missing values fall back", () => {
  for (const p of [null, undefined, "", "   ", "\t"]) assert.equal(safeRedirectPath(p), DEFAULT_REDIRECT);
  assert.equal(safeRedirectPath(null, "/map"), "/map", "the fallback is overridable");
});

test("surrounding whitespace on an otherwise valid path is tolerated", () => {
  assert.equal(safeRedirectPath("  /dashboard  "), "/dashboard");
});

test("REGRESSION: the callback never concatenates `next` onto the origin", () => {
  const src = readFileSync(join(__dirname, "..", "src/app/auth/callback/route.ts"), "utf8");
  assert.ok(/safeRedirectPath/.test(src), "the callback must sanitize `next`");
  assert.ok(!/\$\{origin\}\$\{next\}/.test(src), "string concatenation reintroduces the open redirect");
  assert.ok(/new URL\(/.test(src), "resolve against the origin with the URL constructor instead");
});
