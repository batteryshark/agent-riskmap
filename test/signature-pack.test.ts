import { test } from "node:test";
import assert from "node:assert/strict";

import { SignaturePack, loadSourceCalleePack, type SignatureRule } from "../src/scanner/index.js";

function rule(
  p: Partial<SignatureRule> & Pick<SignatureRule, "atom" | "mode" | "values">,
): SignatureRule {
  return {
    id: p.id ?? "test",
    atom: p.atom,
    surface: p.surface ?? "callee",
    method: "static-source",
    languages: p.languages ?? ["*"],
    mode: p.mode,
    values: p.values,
    confidence: p.confidence ?? 0.5,
    summary: p.summary ?? "test",
    priority: p.priority ?? 0,
    order: p.order ?? 0,
    caseSensitive: p.caseSensitive ?? false,
  };
}

test("matcher: mode semantics + normalization", () => {
  const pack = new SignaturePack(
    "t",
    "0",
    "<mem>",
    [
      rule({ atom: "EXEC.SHELL", mode: "base", values: ["system", "popen"] }),
      rule({ id: "s", atom: "NETW.HTTP", mode: "suffix", values: ["httpclient"], order: 1 }),
      rule({ id: "e", atom: "LOAD.EVAL", mode: "exact", values: ["eval"], order: 2 }),
      rule({ id: "u", atom: "LOAD.IMPORT", mode: "substring", values: ["loadlibrary"], order: 3 }),
      rule({ id: "r", atom: "NETW.DNS", mode: "regex", values: ["^res_\\w+"], order: 4 }),
    ],
    [],
  );
  // base = last "."-segment, "::"/"->" folded to ".", lowercased
  assert.equal(pack.classifyCallee("os.system", "python")?.atom, "EXEC.SHELL");
  assert.equal(pack.classifyCallee("System", "c")?.atom, "EXEC.SHELL");
  assert.equal(pack.classifyCallee("std::popen", "cpp")?.atom, "EXEC.SHELL");
  // suffix
  assert.equal(pack.classifyCallee("net.HttpClient", "csharp")?.atom, "NETW.HTTP");
  // exact does not fire on a longer name
  assert.equal(pack.classifyCallee("eval", "js")?.atom, "LOAD.EVAL");
  assert.equal(pack.classifyCallee("safe_eval", "js"), null);
  // substring
  assert.equal(pack.classifyCallee("kernel32.LoadLibraryA", "c")?.atom, "LOAD.IMPORT");
  // regex
  assert.equal(pack.classifyCallee("res_query", "c")?.atom, "NETW.DNS");
  // nothing
  assert.equal(pack.classifyCallee("harmless_helper", "python"), null);
});

test("matcher: priority then order breaks ties", () => {
  const pack = new SignaturePack(
    "t",
    "0",
    "<mem>",
    [
      rule({ id: "lo", atom: "EXEC.PROC", mode: "base", values: ["exec"], priority: 0, order: 0 }),
      rule({ id: "hi", atom: "EXEC.SHELL", mode: "base", values: ["exec"], priority: 50, order: 1 }),
    ],
    [],
  );
  assert.equal(pack.classifyCallee("exec", "shell")?.atom, "EXEC.SHELL");
});

test("matcher: language selection incl. wildcard", () => {
  const pack = new SignaturePack(
    "t",
    "0",
    "<mem>",
    [
      rule({ id: "go", atom: "NETW.HTTP", mode: "substring", values: ["http.get"], languages: ["go"] }),
      rule({ id: "any", atom: "LOAD.EVAL", mode: "base", values: ["eval"], languages: ["*"], order: 1 }),
    ],
    [],
  );
  assert.equal(pack.classifyCallee("http.get", "go")?.atom, "NETW.HTTP");
  assert.equal(pack.classifyCallee("http.get", "python"), null); // go-only rule doesn't apply
  assert.equal(pack.classifyCallee("eval", "python")?.atom, "LOAD.EVAL"); // wildcard applies
});

const real = loadSourceCalleePack();

test("real pack: loads with the expected shape", () => {
  assert.ok(real, "parallax-taxonomy sibling not found; set PRLX_TAXONOMY_ROOT to a checkout");
  assert.equal(real.id, "parallax.source-callees");
  const callee = real.rules.filter((r) => r.surface === "callee");
  assert.ok(callee.length >= 77, `expected >=77 callee rules, got ${callee.length}`);
  assert.ok(real.observationGates.length >= 1, `expected observation gates, got ${real.observationGates.length}`);
});

/**
 * A value is "reachable by itself" only if feeding it back as a callee could
 * match its own rule. Two pack-data bug classes make some values unreachable
 * (tracked upstream in parallax-taxonomy, not matcher bugs — the parity test
 * proves TS == Python on all of these):
 *   1. "::"/"->" under any non-regex mode — normalization folds these on the
 *      callee but not on rule values.
 *   2. a "." under `base` mode — base compares only the last "."-segment.
 */
function reachableBySelf(mode: string, value: string): boolean {
  if (value.includes("::") || value.includes("->")) return false;
  if (mode === "base" && value.includes(".")) return false;
  return true;
}

test("real pack: every callee rule has at least one reachable value", () => {
  assert.ok(real);
  for (const r of real.rules) {
    if (r.surface !== "callee" || r.mode === "regex") continue;
    const lang = r.languages.includes("*") ? "python" : r.languages[0]!;
    const sample = r.values.find((v) => reachableBySelf(r.mode, v));
    if (sample === undefined) continue; // whole rule is dead (upstream bug; none today)
    assert.ok(
      real.classifyCallee(sample, lang),
      `rule ${r.id}: sample ${JSON.stringify(sample)}/${lang} classified as null`,
    );
  }
});

test("formerly-dead value quirks now classify (regression guard for the pack fixes; parity with Python)", () => {
  assert.ok(real);
  // "::"/"->" class (fixed upstream): rule values now use "." so the folded
  // callee matches. std::fs::write normalizes to std.fs.write -> FSYS.WRITE.
  assert.equal(real.classifyCallee("std::fs::write", "rust")?.atom, "FSYS.WRITE");
  // base-mode dotted value (fixed upstream): R download.file is now matched by an
  // exact-mode rule; base mode only compared the last "."-segment ("file").
  assert.equal(real.classifyCallee("download.file", "r")?.atom, "NETW.HTTP");
});
