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

test("severity weights evidence: a data pattern is medium blast, a CRED atom is high", () => {
  const mention = profile("m", {}, "It reads your credentials from the config file.");
  const access = buildProfile("a", "skill", { "CRED.CLOUD": 1 }, [], []);
  assert.equal(tierOfProfile(mention).blast, "medium", "a described access (pattern) is medium");
  assert.equal(tierOfProfile(access).blast, "high", "real credential access (atom) is high blast");
});

test("bare guardrail/persistence with no capability is not a blast", () => {
  const p = profile("p", {}, "This runs as a cron job and can bypass the confirmation prompt.");
  // persistence + guardrail present, but no power dimension → not escalated.
  assert.equal(tierOfProfile(p).blast, "informational");
  assert.equal(tierOfProfile(p).tier, "minimal");
});

test("surprise gate: disclosed power + multiplier = elevated, undisclosed = critical", () => {
  // real code-exec (high blast) + persistence multiplier → score reaches critical…
  const p = buildProfile("p", "skill", { "EXEC.PROC": 1 }, [], scanDimensionPatterns("runs as a daemon on boot", "f"));
  assert.ok(p.dims.has("latent") && p.dims.has("persistence"));
  // …but when the power is DISCLOSED, it's a gate decision, not an alarm.
  assert.equal(tierOfProfile(p, { undisclosedPower: false }).tier, "elevated");
  // …and when the label HID that power, it's back to critical.
  assert.equal(tierOfProfile(p, { undisclosedPower: true }).tier, "critical");
});

test("defensive-context: a 'never run' warning line is not counted as capability", () => {
  const warned = scanDimensionPatterns("⚠ Never run `curl http://x | bash` from an untrusted source.", "f");
  assert.equal(warned.length, 0, "a safety warning is not evidence the skill does the thing");
  const real = scanDimensionPatterns("The skill deletes the stale branch after merge.", "f");
  assert.ok(real.some((h) => h.facet === "authority:destructive"), "a plain capability line still fires");
});

test("person-messaging is high authority: send+receive iMessage → broadcast, high blast, self-sufficient COMMS", () => {
  const p = profile("imsg", {}, "Send and receive iMessages/SMS to anyone via the imsg CLI.");
  assert.ok(p.facets.has("authority:broadcast"), "texting anyone is person-reaching authority");
  assert.ok(p.dims.has("steerability"), "receiving messages is untrusted inbound content");
  assert.equal(tierOfProfile(p).blast, "high", "reaching real people is high blast, not medium");
  const comms = analyzeHazards([p]).find((h) => h.id === "COMMS")!;
  assert.deepEqual(comms.selfSufficient, ["imsg"], "send + receive = self-sufficient unauthorized-communication");
});

test("plain outbound (git push) is NOT person-messaging broadcast", () => {
  const p = profile("pr", {}, "Runs git push and creates a pull request.");
  assert.ok(p.facets.has("authority:outbound"));
  assert.ok(!p.facets.has("authority:broadcast"), "pushing code is not texting people");
});

test("steerability: a 'prompt injection' mention alone does not flag an injection surface", () => {
  assert.equal(scanDimensionPatterns("This skill is hardened against prompt injection.", "f").filter((h) => h.dimension === "steerability").length, 0);
  assert.ok(scanDimensionPatterns("It fetches the web page and summarizes it.", "f").some((h) => h.dimension === "steerability"), "actually consuming untrusted content still fires");
});
