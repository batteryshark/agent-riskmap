import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProfile, scanDimensionPatterns } from "../src/dimensions.js";
import { analyzeHazards } from "../src/hazards.js";
import { tierOfProfile } from "../src/severity.js";

function profile(target: string, atoms: Record<string, number>, text: string) {
  return buildProfile(target, "skill", atoms, [], scanDimensionPatterns(text, target));
}

test("atoms map to dimensions; a URL in text (ARTF.URL) is NOT reach", () => {
  const p = buildProfile("t", "skill", { "CRED.CLOUD": 1, "NETW.HTTP": 1, "EXEC.PROC": 1, "FSYS.DELETE": 1 }, [], []);
  assert.ok(p.facets.has("data:sensitive"));
  assert.ok(p.facets.has("reach:egress"));
  assert.ok(p.dims.has("latent"));
  assert.ok(p.facets.has("authority:destructive"));
  const q = buildProfile("t", "skill", { "ARTF.URL": 5 }, [], []);
  assert.ok(!q.dims.has("reach"), "a documentation URL is not egress");
});

test("guardrail pattern is precise: bypass yes, 'no sudo needed' no", () => {
  assert.ok(scanDimensionPatterns("run it with --dangerously-skip-permissions", "f").some((h) => h.dimension === "guardrail"));
  assert.equal(scanDimensionPatterns("No sudo needed for this skill.", "f").filter((h) => h.dimension === "guardrail").length, 0);
});

test("data pattern is scoped: 'API keys' yes, bare 'token' no", () => {
  assert.ok(scanDimensionPatterns("put your API keys in .env", "f").some((h) => h.dimension === "data"));
  assert.equal(scanDimensionPatterns("the tokenizer splits each token", "f").filter((h) => h.dimension === "data").length, 0);
});

test("hazards compose: EXFIL self-sufficient vs cross-skill pairing", () => {
  const both = buildProfile("both", "skill", { "CRED.CLOUD": 1, "NETW.HTTP": 1 }, [], []);
  const src = buildProfile("src", "skill", { "CRED.CLOUD": 1 }, [], []);
  const snk = buildProfile("snk", "skill", { "NETW.HTTP": 1 }, [], []);

  const self = analyzeHazards([both]).find((h) => h.id === "EXFIL")!;
  assert.deepEqual(self.selfSufficient, ["both"]);

  const cross = analyzeHazards([src, snk]).find((h) => h.id === "EXFIL")!;
  assert.equal(cross.selfSufficient.length, 0);
  assert.equal(cross.crossPairs, 1);
});

test("severity is pessimistic: guardrail-bypass + capability = critical", () => {
  const cc = profile("cc", {}, "Delegate coding to Claude Code with --dangerously-skip-permissions; it can spawn a subagent.");
  const t = tierOfProfile(cc);
  assert.ok(t.multipliers.includes("guardrail"));
  assert.equal(t.tier, "critical");
});

test("severity weights evidence: a data MENTION is medium blast, a CRED atom is high", () => {
  const mention = profile("m", {}, "Set your API keys in the config file.");
  const access = buildProfile("a", "skill", { "CRED.CLOUD": 1 }, [], []);
  assert.equal(tierOfProfile(mention).blast, "medium", "a mention is not an access");
  assert.equal(tierOfProfile(access).blast, "high", "real credential access is high blast");
});

test("bare guardrail/persistence with no capability is not a blast", () => {
  const p = profile("p", {}, "This runs as a cron job and can bypass the confirmation prompt.");
  // persistence + guardrail present, but no power dimension → not escalated.
  assert.equal(tierOfProfile(p).blast, "informational");
  assert.equal(tierOfProfile(p).tier, "minimal");
});
