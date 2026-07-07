import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initLedger,
  addItem,
  startItem,
  resolveItem,
  setLabelItem,
  resume,
  getCoverage,
  isActionable,
  loadState,
  EXIT_CONTINUE,
  EXIT_COMPLETE,
} from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sf-ledger-"));
}

test("ledger owns termination: resume completes only when all items terminal", () => {
  const cwd = tmp();
  try {
    initLedger({ subject: "agent-risk", categories: ["combo"], operations: ["review"], cwd });
    const a = addItem({ target: "exfil-duo", operation: "review", category: "combo", title: "EXFIL pairing", cwd });
    assert.equal(a.status, "discovered");

    // one non-terminal item → continue
    assert.equal(resume(3, cwd).exitCode, EXIT_CONTINUE);

    startItem(a.id, cwd);
    assert.equal(loadState(cwd)!.items[0]!.status, "in_progress");
    resolveItem(a.id, "confirmed self-sufficient EXFIL path", undefined, "confirmed", cwd);

    const { total, terminal } = getCoverage(loadState(cwd)!);
    assert.equal(total, 1);
    assert.equal(terminal, 1);
    // all terminal → complete
    assert.equal(resume(3, cwd).exitCode, EXIT_COMPLETE);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("state_label is orthogonal to status (loop driver ignores it)", () => {
  const cwd = tmp();
  try {
    initLedger({ subject: "s", categories: ["finding"], cwd });
    const i = addItem({ target: "t", operation: "review", category: "finding", title: "x", stateLabel: "new", cwd });
    assert.equal(i.state_label, "new");
    startItem(i.id, cwd);
    setLabelItem(i.id, "evaluating", cwd);
    // status is in_progress (non-terminal) regardless of the label
    const item = loadState(cwd)!.items[0]!;
    assert.equal(item.state_label, "evaluating");
    assert.equal(item.status, "in_progress");
    assert.equal(resume(3, cwd).exitCode, EXIT_CONTINUE); // label doesn't terminate
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dependency DAG gates actionability", () => {
  const cwd = tmp();
  try {
    initLedger({ subject: "s", categories: ["c"], cwd });
    const dep = addItem({ target: "a", operation: "scan", category: "c", title: "scan", cwd });
    const b = addItem({ target: "a", operation: "review", category: "c", title: "review", dependsOn: [dep.id], cwd });
    let st = loadState(cwd)!;
    assert.equal(isActionable(st, st.items.find((x) => x.id === b.id)!), false); // dep not terminal
    startItem(dep.id, cwd);
    resolveItem(dep.id, "done", undefined, undefined, cwd);
    st = loadState(cwd)!;
    assert.equal(isActionable(st, st.items.find((x) => x.id === b.id)!), true); // dep terminal → actionable
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
