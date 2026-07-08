/**
 * Triage: the bridge from the deterministic profile to the semantic review.
 *
 * The deterministic pass profiles EVERY skill along the seven dimensions and
 * pre-scores it pessimistically. `seedTriageLedger` puts one item per skill into
 * the ledger — nothing is silently "inert" — worst-tier first, so the loop
 * front-loads risk and can be stopped early. The model then *reviews* each skill:
 * confirms/refines the dimensions, identifies hazards, tags domain, and may only
 * downgrade the pessimistic default on the record. See docs/RISK-TAXONOMY.md.
 */

import { workflow, type AgentRiskReport, type TargetReport } from "./product.js";
import { initLedger, addItem, loadState, getNextActionable, type LedgerState } from "./ledger.js";

const TIER_RANK: Record<string, number> = { critical: 4, elevated: 3, moderate: 2, minimal: 1 };

export interface SeedResult {
  report: AgentRiskReport;
  itemCount: number;
  ledger: LedgerState;
}

function crossRoles(report: AgentRiskReport, target: string): string[] {
  const out: string[] = [];
  for (const c of report.overview.crossSkillCompositions) {
    if (c.aOnly.includes(target)) out.push(`${c.id}: you are "${c.aName}" — pairs with ${c.bName}: [${c.bOnly.join(", ")}]`);
    if (c.bOnly.includes(target)) out.push(`${c.id}: you are "${c.bName}" — pairs with ${c.aName}: [${c.aOnly.join(", ")}]`);
  }
  return out;
}

function evidenceFor(report: AgentRiskReport, t: TargetReport): string {
  const cites = t.hints
    .slice(0, 8)
    .map((h) => `    - ${h.dimension}${h.facet ? `(${h.facet.split(":")[1]})` : ""} «${h.evidence.replace(/\s+/g, " ").slice(0, 60)}»${h.path ? ` @ ${h.path}:${h.line}` : ""} [${h.source}]`)
    .join("\n");
  const cross = crossRoles(report, t.target);
  return (
    `SKILL: ${t.target}  (kind: ${t.kind})\n` +
    `Deterministic profile (a PESSIMISTIC prior — confirm, refine, or downgrade):\n` +
    `  dimensions: ${t.dimensions.join(", ") || "none detected"}\n` +
    `  facets:     ${t.facets.join(", ") || "—"}\n` +
    `  self-sufficient hazards: ${t.hazards.join(", ") || "none"}\n` +
    `  default tier: ${t.tier}\n` +
    (cross.length ? `  cross-skill roles:\n    ${cross.join("\n    ")}\n` : "") +
    `  hint citations:\n${cites || "    (no signals — verify there is no latent capability the patterns missed)"}`
  );
}

/**
 * Seed one triage item per skill (worst-tier first). Every skill is reviewed —
 * "inert" is a hypothesis to check, not a verdict to trust.
 */
export function seedTriageLedger(opts: { targetDir: string; cwd?: string; force?: boolean }): SeedResult {
  const cwd = opts.cwd ?? process.cwd();
  const report = workflow(opts.targetDir);

  initLedger({
    subject: `agent-riskmap review: ${opts.targetDir}`,
    categories: ["critical", "elevated", "moderate", "minimal"],
    operations: ["review"],
    force: opts.force,
    cwd,
  });

  const ordered = [...report.targets].sort(
    (a, b) => (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || a.target.localeCompare(b.target),
  );

  let itemCount = 0;
  for (const t of ordered) {
    addItem({
      target: t.target,
      operation: "review skill",
      category: t.tier,
      title: `${t.tier.toUpperCase()} — ${t.target}${t.hazards.length ? ` (${t.hazards.join("/")})` : ""}`,
      evidence: evidenceFor(report, t),
      stateLabel: "new",
      cwd,
    });
    itemCount++;
  }

  return { report, itemCount, ledger: loadState(cwd)! };
}

// ── shared prompt text (both harness extensions inject this) ──────────────────

export const TRIAGE_CONTRACT = `## THE CONTRACT
- The ledger at .ledger/state.json is the SINGLE SOURCE OF TRUTH for the skills and coverage.
- Each item is a SKILL with a PESSIMISTIC deterministic profile. Your job is to VERIFY it —
  read the skill, confirm/refine the dimensions, and reach a verdict. You may only DOWNGRADE
  risk with a stated reason; never silently.
- You do NOT decide when to stop. After you go idle the loop reads the ledger; it ends only
  when every skill is terminal. Do NOT output "DONE".
- Every item MUST reach a verdict via the \`ledger\` tool: resolve, accept, or block.`;

export const TRIAGE_PROCEDURE = `## HOW TO REVIEW ONE SKILL
1. \`ledger\` action "next" → the skill; then "start", id "<id>" (state_label → "evaluating").
2. Read the skill's files (esp. SKILL.md). Assess it along the seven dimensions — do not just
   trust the hints; understand what the skill ENABLES the agent to do (latent functionality):
   - ① Action Authority — can it send / post / share, or delete / overwrite / revoke on your behalf?
   - ② Data Access & Scope — what sensitive data can it read, and how much (a file vs your whole mailbox)?
   - ③ Latent Capability — does it run arbitrary code, install software, or DELEGATE to another agent?
   - ④ Guardrail Posture — does it bypass permissions / sudo / auto-accept dialogs? (a multiplier)
   - ⑤ Steerability — does it consume UNTRUSTED content (web, email, files) that could steer it?
   - ⑥ Reach — network egress / external services.
   - ⑦ Persistence — does it run unattended / schedule / survive sessions?
3. Identify hazards (dimension compositions): EXFIL (data×reach), Unauthorized-Communication
   (outbound-authority×steerability), Destructive-Action (destructive-authority×steerability),
   Guardrail-Defeat (latent×bypass), RCE (untrusted-input×code), Autonomous-Persistence.
   Tag any high-stakes DOMAIN (financial / medical / legal) — it raises severity.
4. Record the verdict via the \`ledger\` tool:
   - "resolve"  — real / plausible risk. result = the hazards + the final tier + the gate you
     recommend (sandbox / require HITL / keep skills in separate agents). label "confirmed"
     (or "gated" if already mitigated).
   - "accept"   — the pessimistic prior was over-stated / benign. rationale = why (this is a
     DOWNGRADE, so justify it). label "dismissed".
   - "block"    — needs a human policy decision. reason = what's needed. label "needs-human".
state_label lifecycle: new → evaluating → (confirmed | gated | dismissed | needs-human).
Reminder: guardrail-bypass or autonomy defaults to CRITICAL — only lower it with evidence.`;

export function triageHeader(state: LedgerState | null): string {
  const total = state?.items.length ?? 0;
  const terminal = state?.items.filter((i) => ["resolved", "accepted", "blocked"].includes(i.status)).length ?? 0;
  return (
    `## agent-riskmap review\n` +
    `Subject: ${state?.subject ?? "(no ledger)"}\n` +
    `Coverage: ${terminal}/${total} reviewed (${total - terminal} pending) — worst-tier first\n`
  );
}

export function buildTriageInjection(state: LedgerState | null): string {
  return `\n${triageHeader(state)}\n${TRIAGE_PROCEDURE}\n\n${TRIAGE_CONTRACT}\n`;
}

export function formatNextItem(state: LedgerState | null): string {
  if (!state) return "## No ledger found. Run a scan first (agent_riskmap_scan).";
  const item = getNextActionable(state);
  if (!item) return `## No skill left to review.\nUse the \`ledger\` tool (action "show" / "pending") to inspect.`;
  return (
    `## NEXT SKILL TO REVIEW\n` +
    `  id:       ${item.id}\n` +
    `  tier:     ${item.category}   status: ${item.status}   state_label: ${item.state_label}\n` +
    `  skill:    ${item.target}\n\n` +
    `${item.evidence ?? "  (no profile)"}\n\n` +
    `Begin: \`ledger\` action "start", id "${item.id}", then read the skill's files.`
  );
}

export function buildTriageTurn(state: LedgerState | null): string {
  return `${buildTriageInjection(state)}\n${formatNextItem(state)}`;
}
