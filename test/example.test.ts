import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { workflow } from "../src/index.js";

// The committed example surface + its report.html are a public showcase. This test
// pins the findings so the checked-in HTML stays representative — if it drifts,
// regenerate: `agent-riskmap examples/sample-agent --html > examples/report.html`.
const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "sample-agent");

test("the example surface demonstrates every hazard and tier as documented", () => {
  const r = workflow(SAMPLE);
  const haz = (id: string) => r.hazards.find((h) => h.id === id)!;
  const target = (t: string) => r.targets.find((x) => x.target === t)!;

  // self-sufficient hazards
  assert.ok(haz("GUARDRAIL").selfSufficient.includes("code-delegator"));
  assert.ok(haz("PERSIST").selfSufficient.includes("watcher-daemon"));
  assert.ok(haz("COMMS").selfSufficient.includes("inbox-assistant"));

  // cross-skill EXFIL: a secret reader + an off-host sender, dangerous only together
  const exfil = haz("EXFIL");
  assert.equal(exfil.selfSufficient.length, 0, "no single skill both reads secrets and sends them");
  assert.ok(exfil.aOnly.includes("credential-vault"));
  assert.ok(exfil.bOnly.includes("report-uploader"));
  assert.ok(exfil.crossPairs > 0);

  // the delegator is the crown jewel; the benign skill is inert
  assert.equal(target("code-delegator").tier, "critical");
  assert.equal(target("text-formatter").dimensions.length, 0);

  // the description-gap skill: claims "local", actually reaches out
  assert.ok(target("note-sync").undisclosed.length > 0, "note-sync hides its network reach");

  // the surface spans kinds
  assert.ok(r.surface.skill >= 8 && r.surface.mcp >= 1 && r.surface.prompt >= 1);
});
