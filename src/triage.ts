/**
 * Triage: the bridge between the deterministic scan and the agentic loop.
 *
 * The deterministic half (workflow) is *always complete* — it finds every
 * reachable capability combination. Those are candidate findings, not verdicts.
 * `seedTriageLedger` turns each finding into a ledger item the harness model then
 * interrogates (read evidence → follow flow → confirm / dismiss / gate). The
 * ledger — not the model — owns coverage and termination; the model only decides
 * *per finding*, never *when to stop*. See LOOP.md.
 */

import { workflow, type AgentRiskReport, type TargetReport } from "./product.js";
import { initLedger, addItem, loadState, getNextActionable, type LedgerState } from "./ledger.js";

/** Ledger categories = the abuse compositions. */
export const TRIAGE_CATEGORIES = ["EXFIL", "RCE", "DROP"] as const;

export interface SeedResult {
  report: AgentRiskReport;
  itemCount: number;
  ledger: LedgerState;
}

function targetEvidence(report: AgentRiskReport, targetPath: string): string {
  const t: TargetReport | undefined = report.targets.find((x) => x.target === targetPath);
  if (!t) return `    (target "${targetPath}" not found in report)`;
  const fams = t.families.length ? t.families.join(", ") : "none";
  const cites =
    t.evidence.length > 0
      ? t.evidence
          .slice(0, 6)
          .map((e) => `      - ${e.atom} @ ${e.path}:${e.line}  «${e.evidence.replace(/\s+/g, " ").slice(0, 80)}»`)
          .join("\n")
      : "      (no file citations captured)";
  return `    families: ${fams}\n    cited evidence:\n${cites}`;
}

/**
 * Run the deterministic scan and seed the ledger with one triage item per
 * self-sufficient target and per cross-skill composition. Cross-skill items are
 * seeded per COMPOSITION (not per pairing) — the pairing count is combinatorial
 * (sources × sinks) and the adjudication is really "is each source/sink real,
 * and should they be co-enabled," which is one decision per composition.
 */
export function seedTriageLedger(opts: { targetDir: string; cwd?: string; force?: boolean }): SeedResult {
  const cwd = opts.cwd ?? process.cwd();
  const report = workflow(opts.targetDir);

  initLedger({
    subject: `agent-riskmap triage: ${opts.targetDir}`,
    categories: [...TRIAGE_CATEGORIES],
    operations: ["triage"],
    force: opts.force,
    cwd,
  });

  let itemCount = 0;
  for (const c of report.combos) {
    for (const t of c.selfSufficient) {
      addItem({
        target: t,
        operation: "verify self-sufficient abuse path",
        category: c.id,
        title: `${c.id}: "${t}" may complete "${c.label}" alone`,
        evidence:
          `SELF-SUFFICIENT ${c.id} — ${c.label}.\n` +
          `One target holds BOTH halves (source and sink) of this path.\n` +
          `Target: ${t}\n${targetEvidence(report, t)}`,
        stateLabel: "new",
        cwd,
      });
      itemCount++;
    }

    if (c.crossPairs > 0) {
      const sources = c.sourceOnly.map((s) => `  SOURCE ${s}\n${targetEvidence(report, s)}`).join("\n");
      const sinks = c.sinkOnly.map((s) => `  SINK   ${s}\n${targetEvidence(report, s)}`).join("\n");
      addItem({
        target: `${c.id} · cross-skill`,
        operation: "verify cross-skill co-enable risk",
        category: c.id,
        title: `${c.id}: ${c.sourceOnly.length} source(s) × ${c.sinkOnly.length} sink(s) = ${c.crossPairs} co-enable pairing(s)`,
        evidence:
          `CROSS-SKILL ${c.id} — ${c.label}.\n` +
          `No single target completes this alone, but co-enabling a source with a sink does ` +
          `(${c.crossPairs} pairing(s)).\n\n${sources}\n${sinks}`,
        stateLabel: "new",
        cwd,
      });
      itemCount++;
    }
  }

  return { report, itemCount, ledger: loadState(cwd)! };
}

// ── shared prompt text (both harness extensions inject this) ──────────────────

export const TRIAGE_CONTRACT = `## THE CONTRACT
- The ledger at .ledger/state.json is the SINGLE SOURCE OF TRUTH for findings and coverage.
- The findings were produced by a deterministic scan. Do NOT invent new findings and do
  NOT re-run detection — your job is to ADJUDICATE what the scan already found.
- You do NOT decide when to stop. After you go idle the loop reads the ledger; it ends only
  when every item is terminal. Do NOT output "DONE" or any completion promise.
- Every item MUST reach a terminal verdict via the \`ledger\` tool: resolve, accept, or block.`;

export const TRIAGE_PROCEDURE = `## HOW TO TRIAGE ONE FINDING
1. \`ledger\` action "next" → the finding; then action "start", id "<id>" (state_label → "evaluating").
2. Open the cited files at the given lines. Follow the actual data/control flow:
   - SOURCE side (CRED / FSWRITE): does it really read a secret / write an executable path,
     or is it a hardcoded example, a doc snippet, a variable name?
   - SINK side (NET / BROWSER / EXEC / LOAD): does it really send off-host / execute, or is it
     localhost-only, a constant URL, a disabled path?
   - SELF-SUFFICIENT: does one tool chain source→sink on attacker-influenceable input?
   - CROSS-SKILL: confirm each source truly reads secrets and each sink truly sends/executes.
3. Record the verdict via the \`ledger\` tool:
   - action "resolve"  — real or plausible abuse path. result = the concrete path + the gate you
     recommend (sandbox / require HITL / keep the two skills in separate agents). Set label
     "confirmed", or "gated" if it is already adequately mitigated.
   - action "accept"   — false positive / not exploitable. rationale = why. Set label "dismissed".
   - action "block"    — needs a human policy decision you cannot make. reason = what's needed.
     Set label "needs-human".
state_label lifecycle: new → evaluating → (confirmed | gated | dismissed | needs-human).`;

/** Header shown each iteration with live coverage. */
export function triageHeader(state: LedgerState | null): string {
  const total = state?.items.length ?? 0;
  const terminal = state?.items.filter((i) => ["resolved", "accepted", "blocked"].includes(i.status)).length ?? 0;
  return (
    `## agent-riskmap triage\n` +
    `Subject: ${state?.subject ?? "(no ledger)"}\n` +
    `Coverage: ${terminal}/${total} adjudicated (${total - terminal} pending)\n`
  );
}

/** Full per-iteration injection: header + procedure + contract. */
export function buildTriageInjection(state: LedgerState | null): string {
  return `\n${triageHeader(state)}\n${TRIAGE_PROCEDURE}\n\n${TRIAGE_CONTRACT}\n`;
}

/** The single next finding to adjudicate, formatted for the model. */
export function formatNextItem(state: LedgerState | null): string {
  if (!state) return "## No ledger found. Run a scan first (agent_riskmap_scan).";
  const item = getNextActionable(state);
  if (!item) return `## No actionable finding right now.\nUse the \`ledger\` tool (action "show" / "pending") to inspect what remains.`;
  return (
    `## NEXT FINDING TO TRIAGE\n` +
    `  id:       ${item.id}\n` +
    `  category: ${item.category}   status: ${item.status}   state_label: ${item.state_label}\n` +
    `  target:   ${item.target}\n` +
    `  title:    ${item.title}\n\n` +
    `  evidence:\n${item.evidence ?? "  (none)"}\n\n` +
    `Begin: \`ledger\` action "start", id "${item.id}".`
  );
}

/** One triage turn: coverage + procedure + contract + the next finding to work. */
export function buildTriageTurn(state: LedgerState | null): string {
  return `${buildTriageInjection(state)}\n${formatNextItem(state)}`;
}
