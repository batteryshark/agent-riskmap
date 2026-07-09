/**
 * Self-contained HTML report renderer — layered and plain-English.
 *
 * Two audiences, two zones. The top of every card is written for a decision-maker: what
 * the skill claims to do, whether it does *more* than that (the "surprise"), what enabling
 * it grants, and the one thing to do. The security detail — dimensions, hazards, evidence —
 * folds into a collapsed "for reviewers" drill-down. Skills are grouped surprise-first:
 *
 *   1. Does more than it says   — undisclosed power; the label hides it. Leads.
 *   2. Powerful by design       — real capability, but disclosed. Calm; gate it.
 *   3. Lower-risk / no signal    — collapsed table.
 *
 * Inline CSS, no external assets.
 */

import type { AgentRiskReport, TargetReport } from "./product.js";
import type { Tier } from "./severity.js";
import type { HazardId } from "./hazards.js";
import type { TargetKind } from "./scan.js";
import { DIM_PLAIN, FACET_PLAIN, HAZARD_PLAIN, HAZARD_TITLE, MULTIPLIER_PLAIN } from "./plain.js";

const KIND_LABEL: Record<TargetKind, string> = {
  skill: "skills", mcp: "mcp", tool: "tools", hooks: "hooks", prompt: "prompts",
};

const TIER_HEX: Record<Tier, string> = {
  critical: "#b91c1c",
  elevated: "#b45309",
  moderate: "#1d4ed8",
  minimal: "#4b5563",
};

// Plain-language posture for the header, in place of "posture: critical".
const POSTURE_PLAIN: Record<Tier, string> = {
  critical: "Action needed",
  elevated: "Review & gate",
  moderate: "Worth a look",
  minimal: "Looks clean",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rankTier(t: Tier): number {
  return t === "critical" ? 0 : t === "elevated" ? 1 : t === "moderate" ? 2 : 3;
}

function byTier(a: TargetReport, b: TargetReport): number {
  return rankTier(a.tier) - rankTier(b.tier) || a.target.localeCompare(b.target);
}

/** Plain "what it can do" phrases for a skill, preferring facets over bare dimensions. */
function capabilityPhrases(t: TargetReport): string[] {
  const out: string[] = [];
  const covered = new Set<string>();
  for (const f of t.facets) {
    out.push(FACET_PLAIN[f]);
    covered.add(f.split(":")[0]!);
  }
  for (const d of t.dimensions) {
    if (!covered.has(d)) out.push(DIM_PLAIN[d]);
  }
  return out;
}

/** Capability chips, with the ones the label doesn't disclose marked inline (not duplicated). */
function capChips(t: TargetReport): string {
  const undis = new Set(t.undisclosed);
  const caps = capabilityPhrases(t);
  if (!caps.length) return `<span class="muted">no notable capability detected</span>`;
  return caps
    .map((c) => {
      const u = undis.has(c);
      return `<span class="cap${u ? " u" : ""}"${u ? ' title="not in its description"' : ""}>${esc(c)}${u ? " ·⚠" : ""}</span>`;
    })
    .join("");
}

/** The single action clause for a skill — one sentence, no stacking. */
function actionLine(t: TargetReport): { text: string; cls: string } {
  if (t.kind === "hooks") return { text: "Turn off — it runs automatically, with no prompt.", cls: "a-red" };
  if (t.tier === "critical") return { text: "Turn off, or gate behind explicit approval before enabling.", cls: "a-red" };
  if (t.tier === "elevated") return { text: "Gate behind approval before enabling.", cls: "a-amber" };
  if (t.tier === "moderate" && t.surprise) return { text: "Review what it actually does before enabling.", cls: "a-blue" };
  if (t.tier === "moderate") return { text: "Fine to enable; review if the capability matters to you.", cls: "a-blue" };
  return { text: "Fine to enable.", cls: "a-blue" };
}

/** The plain risk sentences for a skill — the hazards it completes on its own, no jargon tail. */
function riskSentences(t: TargetReport): string[] {
  const out = t.hazards.map((h) => HAZARD_PLAIN[h]);
  if (!out.length && capabilityPhrases(t).length) {
    out.push("On its own it can't complete an abuse path, but paired with the wrong other skill it could (see how skills combine, below).");
  }
  return out;
}

/** The surprise lead — why this skill is in the "does more than it says" section. */
function surpriseLead(t: TargetReport): string {
  if (t.undisclosed.length) {
    return `<strong>Does more than its label says.</strong> Not mentioned in its description: ${t.undisclosed.map(esc).join(", ")}.`;
  }
  if (!t.description) {
    const caps = capabilityPhrases(t);
    return `<strong>No description declared</strong> — nothing tells you whether it's meant to ${caps.length ? caps.map(esc).join(", ") : "do what it does"}.`;
  }
  return `<strong>Holds capability its description doesn't fully account for.</strong>`;
}

/** Parse the model's triage verdict into a lead narrative (WHAT IT DOES / LABEL MATCH + rest). */
function verdictLead(result: string): string {
  const what = result.match(/WHAT IT DOES:\s*(.+)/i)?.[1]?.trim();
  const match = result.match(/LABEL MATCH:\s*(.+)/i)?.[1]?.trim();
  const rest = result
    .replace(/^\s*(ACCEPTED|BLOCKED):\s*/i, "")
    .split(/\n/)
    .filter((l) => !/^\s*(WHAT IT DOES|LABEL MATCH):/i.test(l))
    .join(" ")
    .trim();
  const bits: string[] = [];
  if (what) bits.push(`<div class="desc"><span class="lbl">What it does:</span> ${esc(what)}</div>`);
  if (match) bits.push(`<div class="desc"><span class="lbl">Label match:</span> ${esc(match)}</div>`);
  if (rest) bits.push(`<div class="desc muted">${esc(rest)}</div>`);
  return bits.join("");
}

/** The collapsed "for reviewers" security detail: dimensions, amplifiers, hazards, evidence. */
function reviewerDetail(t: TargetReport): string {
  const mults = t.multipliers.filter((m) => m === "guardrail" || m === "steerability" || m === "persistence" || m === "delegated-trust");
  const dims = t.dimensions.map((d) => `<span class="cap">${esc(DIM_PLAIN[d])}</span>`).join("");
  const amps = mults.length
    ? `<div class="rd-row"><span class="lbl">Amplifiers:</span> ${mults.map((m) => `<span class="cap">${esc(MULTIPLIER_PLAIN[m as "guardrail" | "steerability" | "persistence" | "delegated-trust"])}</span>`).join("")}</div>`
    : "";
  const haz = t.hazards.length
    ? `<div class="rd-row"><span class="lbl">Completes alone:</span> ${t.hazards.map((h) => `<span class="hid">${esc(h)}</span>`).join(" ")}</div>`
    : "";
  const ev = t.hints.length
    ? `<table class="evtbl">
         <thead><tr><th>capability</th><th>source</th><th>matched</th><th>where</th></tr></thead>
         <tbody>${t.hints.map((h) => `<tr>
             <td>${esc(h.facet ? FACET_PLAIN[h.facet] : DIM_PLAIN[h.dimension])}</td>
             <td><span class="src src-${h.source}">${h.source}</span></td>
             <td class="mono">${esc(h.evidence)}</td>
             <td class="mono">${h.path ? esc(h.path) : ""}${h.line ? `:${h.line}` : ""}</td>
           </tr>`).join("")}</tbody>
       </table>`
    : `<div class="rd-row muted">No deterministic signals — verify there's no latent capability the patterns missed.</div>`;
  return `<details class="ev"><summary>for reviewers — signals &amp; evidence</summary>
      <div class="rd">
        <div class="rd-row"><span class="lbl">Reads as:</span> ${dims || `<span class="muted">no capability dimensions</span>`}</div>
        ${amps}${haz}${ev}
      </div>
    </details>`;
}

/** A full card (used for the surprise and powerful-by-design sections). */
function skillCard(t: TargetReport): string {
  const act = actionLine(t);
  const desc = t.description
    ? `<div class="desc"><span class="lbl">Says it:</span> ${esc(t.description)}</div>`
    : `<div class="desc"><span class="lbl">Says it:</span> <span class="muted">(no description declared)</span></div>`;

  // A reviewed skill leads with the model's narrative; otherwise with the deterministic read.
  let lead: string;
  if (t.verdict) {
    lead = verdictLead(t.verdict.result);
  } else if (t.surprise) {
    lead = `<div class="lead surprise">${surpriseLead(t)}</div>`;
  } else {
    const risks = riskSentences(t);
    lead = risks.length ? `<div class="lead"><span class="lbl">Why it matters:</span> ${esc(risks[0]!)}</div>` : "";
  }

  const grants = `<div class="caps"><span class="lbl">${t.surprise ? "Can actually" : "Enabling it grants"}:</span> ${capChips(t)}</div>`;
  const extraRisk = !t.verdict && t.surprise
    ? riskSentences(t).map((r) => `<div class="lead muted">${esc(r)}</div>`).join("")
    : "";
  const vtag = t.verdict
    ? `<span class="tier-badge sm" style="background:${TIER_HEX[t.tier]}">${esc(t.verdict.label || t.verdict.status)}</span>`
    : "";

  const hideBadge = t.surprise && !t.verdict
    ? `<span class="hide-badge" title="holds capability its description doesn't mention">⚠ undisclosed</span>`
    : "";
  return `<div class="card tier-${t.tier}">
      <div class="card-top">
        <span class="tier-dot" style="background:${TIER_HEX[t.tier]}"></span>
        <span class="tname mono">${esc(t.target)}</span>
        <span class="kbadge">${esc(t.kind)}</span>
        ${hideBadge}${vtag}
        <span class="tier-badge" style="background:${TIER_HEX[t.tier]}">${esc(t.tier)}</span>
      </div>
      ${desc}${lead}${grants}${extraRisk}
      <div class="do"><span class="lbl">Do:</span> <span class="act ${act.cls}">${esc(act.text)}</span></div>
      ${reviewerDetail(t)}
    </div>`;
}

/** A compact collapsed row for the lower-risk table. */
function skillRow(t: TargetReport): string {
  const desc = t.description ? esc(t.description) : `<span class="muted">(no description)</span>`;
  return `<tr class="skill-row"><td>
      <details>
        <summary>
          <span class="tier-dot" style="background:${TIER_HEX[t.tier]}"></span>
          <span class="mono tname">${esc(t.target)}</span>
          <span class="tier-badge sm" style="background:${TIER_HEX[t.tier]}">${esc(t.tier)}</span>
          <span class="lr-desc">${desc}</span>
        </summary>
        <div class="detail">
          <div class="caps">${capChips(t)}</div>
          ${reviewerDetail(t)}
        </div>
      </details>
    </td></tr>`;
}

function actionSummary(report: AgentRiskReport): string {
  const ts = report.targets;
  const names = (arr: TargetReport[]) => arr.map((t) => `<span class="mono">${esc(t.target)}</span>`).join(", ");
  const turnOff = ts.filter((t) => t.tier === "critical").sort(byTier);
  const gate = ts.filter((t) => t.tier === "elevated").sort(byTier);
  const look = ts.filter((t) => t.surprise && t.tier !== "critical" && t.tier !== "elevated").sort(byTier);
  const restCount = ts.length - turnOff.length - gate.length - look.length;

  const items: string[] = [];
  if (turnOff.length) items.push(`<li><span class="act a-red">Turn off or gate</span> ${names(turnOff)} — either does more than its label says or bypasses safety.</li>`);
  if (gate.length) items.push(`<li><span class="act a-amber">Gate behind approval</span> ${names(gate)} — powerful by design; fine to run, but you're granting real authority.</li>`);
  if (look.length) items.push(`<li><span class="act a-blue">Take a look</span> ${names(look)} — does more than its description mentions.</li>`);
  if (restCount > 0) items.push(`<li>The other ${restCount} ${restCount === 1 ? "is" : "are"} lower-risk.</li>`);
  if (!items.length) items.push(`<li>Nothing needs action — the surface looks clean.</li>`);

  return `<div class="summary"><h3>What to do</h3><ul>${items.join("")}</ul></div>`;
}

function appendix(report: AgentRiskReport): string {
  const active = report.hazards.filter((h) => h.selfSufficient.length > 0 || h.crossPairs > 0);
  if (!active.length) return `<p class="muted">No skills combine into an abuse path.</p>`;
  const blocks = active.map((h) => {
    const self = h.selfSufficient.length
      ? `<div class="pair"><span class="role">one skill does it all</span><ul>${h.selfSufficient.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></div>`
      : "";
    const cross = h.crossPairs > 0
      ? `<details><summary>${h.aOnly.length} + ${h.bOnly.length} skills that combine into it</summary>
           <div class="pair"><span class="role">${esc(h.aName)}</span><ul>${h.aOnly.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></div>
           <div class="pair"><span class="role">${esc(h.bName)}</span><ul>${h.bOnly.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></div></details>`
      : "";
    return `<div class="hz-blk">
        <div class="hz-h">${esc(HAZARD_TITLE[h.id as HazardId])} <span class="hid">${esc(h.id)}</span></div>
        <div class="muted" style="font-size:12.5px;margin-bottom:4px">${esc(HAZARD_PLAIN[h.id as HazardId])}</div>
        ${self}${cross}
      </div>`;
  });
  return `<p class="muted">These only matter when two skills run in the same agent: one supplies half the path, the other the rest — harmless apart.</p>
    <div class="hz-list">${blocks.join("")}</div>`;
}

/** The LABEL MATCH keyword the triage model recorded (matches / understates / … / ""). */
function labelMatch(t: TargetReport): string {
  return (t.verdict?.result.match(/LABEL MATCH:\s*([a-z-]+)/i)?.[1] ?? "").toLowerCase();
}

/**
 * Which section a reviewed skill belongs in. Here the MODEL's judgment drives placement:
 * "does more than it says" is exactly the skills it found to understate/mismatch their
 * label — expected-but-unstated power (a maps tool that calls a maps API) reads as
 * "matches" and moves to "powerful by design" instead. Dismissed → lower-risk.
 */
function bucketReviewed(t: TargetReport): "surprise" | "powerful" | "lower" {
  if (!t.verdict) return t.surprise ? "surprise" : t.tier === "critical" || t.tier === "elevated" ? "powerful" : "lower";
  if (t.verdict.status === "accepted") return "lower";
  if (/understate|mismatch/.test(labelMatch(t))) return "surprise";
  return t.tier === "critical" || t.tier === "elevated" ? "powerful" : "lower";
}

function statRow(cells: Array<[number, string]>): string {
  return `<div class="stats">${cells.map(([n, l]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("")}</div>`;
}

export function renderHtml(report: AgentRiskReport, dir: string): string {
  const p = report.posture;
  const generated = new Date().toISOString().replace("T", " ").replace(/\..+/, " UTC");

  const surfaceParts = (Object.entries(report.surface) as Array<[TargetKind, number]>)
    .filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_LABEL[k]}`);

  const reviewed = report.targets.some((t) => t.verdict);

  // Two modes. The scan-only DRAFT leads by tier (the deterministic pass can't reliably
  // tell hidden power from expected-but-unstated power), with ⚠ marking undisclosed
  // capability. The REVIEWED report leads surprise-first, because the model has now read
  // each skill and can separate a real surprise from expected authority.
  let statsHtml: string;
  let sectionsHtml: string;
  let banner: string;

  if (reviewed) {
    const surprises = report.targets.filter((t) => bucketReviewed(t) === "surprise").sort(byTier);
    const powerful = report.targets.filter((t) => bucketReviewed(t) === "powerful").sort(byTier);
    const lower = report.targets.filter((t) => bucketReviewed(t) === "lower").sort(byTier);
    banner = `<div class="banner ok">Reviewed: ${report.targets.filter((t) => t.verdict).length}/${report.targets.length} skills read by the triage model. Sections below reflect its judgment, not just the scan.</div>`;
    statsHtml = statRow([[report.toolCount, "skills"], [surprises.length, "do more than they say"], [powerful.length, "powerful by design"], [lower.length, "lower-risk"]]);
    sectionsHtml = `
  <h2>Does more than it says <span class="sub">(${surprises.length})</span></h2>
  <p class="section-note">The model read these and found capability their description doesn't account for — the gap is the reason to look.</p>
  ${surprises.length ? surprises.map(skillCard).join("") : `<p class="muted">None — every reviewed skill does what it claims.</p>`}

  <h2>Powerful by design <span class="sub">(${powerful.length})</span></h2>
  <p class="section-note">Real authority, but consistent with what they claim. Fine to run — just gate the access you're granting.</p>
  ${powerful.length ? powerful.map(skillCard).join("") : `<p class="muted">None.</p>`}

  <h2>Lower-risk <span class="sub">(${lower.length})</span></h2>
  ${lower.length ? `<table class="all-skills"><tbody>${lower.map(skillRow).join("")}</tbody></table>` : `<p class="muted">None.</p>`}`;
  } else {
    const attention = report.targets.filter((t) => t.tier === "critical" || t.tier === "elevated" || t.surprise).sort(byTier);
    const lower = report.targets.filter((t) => !(t.tier === "critical" || t.tier === "elevated" || t.surprise)).sort(byTier);
    const hides = attention.filter((t) => t.surprise).length;
    banner = `<div class="banner">First-pass scan only — a deliberately cautious prior, not a verdict. ⚠ marks skills holding capability their label doesn't mention; run the triage loop to sort real surprises from simply-powerful skills.</div>`;
    statsHtml = statRow([[report.toolCount, "skills"], [attention.length, "need attention"], [hides, "⚠ hide capability"], [lower.length, "lower-risk"]]);
    sectionsHtml = `
  <h2>Needs attention <span class="sub">(${attention.length})</span></h2>
  <p class="section-note">Highest-impact first. ⚠ marks skills that also hold capability their description doesn't mention.</p>
  ${attention.length ? attention.map(skillCard).join("") : `<p class="muted">Nothing critical or elevated, and nothing hiding capability. Good shape.</p>`}

  <h2>Lower-risk <span class="sub">(${lower.length})</span></h2>
  ${lower.length ? `<table class="all-skills"><tbody>${lower.map(skillRow).join("")}</tbody></table>` : `<p class="muted">None.</p>`}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(report.product)} &middot; ${esc(dir)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; color: #1f2328; background: #f6f8fa; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 0 24px 80px; }
  header { padding: 34px 0 18px; border-bottom: 1px solid #d0d7de; }
  header h1 { margin: 0 0 4px; font-size: 25px; font-weight: 750; letter-spacing: -.01em; }
  header .q { color: #57606a; font-size: 15px; max-width: 720px; }
  header .dir { color: #8c959f; font-size: 12.5px; margin-top: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .posture { display: inline-block; margin-top: 13px; padding: 5px 13px; border-radius: 999px; color: #fff;
             font-weight: 700; font-size: 12.5px; letter-spacing: .03em; background: ${TIER_HEX[p.tier]}; }
  .banner { margin-top: 14px; padding: 9px 13px; border-radius: 7px; font-size: 13px; background: #fff8e6; border: 1px solid #f0d985; color: #6b4e00; }
  .banner.ok { background: #eafaf0; border-color: #9fe3c0; color: #0a6b3b; }
  .summary { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 14px 16px 12px; margin: 20px 0 6px; }
  .summary h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; }
  .summary ul { margin: 0; padding-left: 18px; }
  .summary li { font-size: 13.5px; margin: 4px 0; color: #24292f; }
  .stats { display: flex; flex-wrap: wrap; gap: 26px; margin: 14px 0 4px; }
  .stat .n { font-size: 20px; font-weight: 750; line-height: 1; }
  .stat .l { color: #57606a; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; margin-top: 3px; }
  .muted { color: #6e7781; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  h2 { font-size: 16px; margin: 34px 0 2px; font-weight: 700; }
  h2 .sub { font-weight: 400; color: #6e7781; font-size: 13px; }
  .section-note { color: #6e7781; font-size: 12.5px; margin: 2px 0 8px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-left: 4px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .card.tier-critical { border-left-color: ${TIER_HEX.critical}; }
  .card.tier-elevated { border-left-color: ${TIER_HEX.elevated}; }
  .card.tier-moderate { border-left-color: ${TIER_HEX.moderate}; }
  .card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 9px; }
  .tname { font-weight: 650; font-size: 14.5px; }
  .kbadge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #8c959f;
            border: 1px solid #d0d7de; border-radius: 4px; padding: 0 5px; }
  .hide-badge { font-size: 10px; font-weight: 700; color: #7a5200; background: #fff1d6;
                border: 1px solid #f0d985; border-radius: 4px; padding: 0 5px; }
  .tier-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
  .tier-badge { color: #fff; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
                padding: 1px 7px; border-radius: 999px; margin-left: auto; }
  .tier-badge.sm { margin-left: 0; font-size: 9.5px; opacity: .92; }
  .lbl { color: #57606a; font-weight: 650; font-size: 12px; }
  .desc { font-size: 13.5px; margin: 3px 0; color: #24292f; }
  .lead { font-size: 13.5px; margin: 6px 0; color: #24292f; }
  .lead.surprise { background: #fff8e6; border: 1px solid #f0d985; border-radius: 6px; padding: 7px 10px; color: #6b4e00; }
  .caps { margin: 7px 0 4px; }
  .cap { display: inline-block; background: #eaeef2; color: #24292f; padding: 1px 8px; border-radius: 5px;
         margin: 2px 3px 2px 0; font-size: 12.5px; }
  .cap.u { background: #fff1d6; color: #7a5200; }
  .do { margin: 9px 0 2px; font-size: 13.5px; }
  .act { font-weight: 700; }
  .act.a-red { color: #b91c1c; }
  .act.a-amber { color: #b45309; }
  .act.a-blue { color: #1d4ed8; }
  details.ev, details summary { cursor: pointer; }
  details.ev > summary { font-size: 12px; color: #57606a; margin-top: 8px; }
  .rd { margin-top: 8px; }
  .rd-row { margin: 5px 0; font-size: 12.5px; }
  .evtbl { width: 100%; border-collapse: collapse; margin-top: 8px; border: 1px solid #eaeef2; border-radius: 6px; overflow: hidden; }
  .evtbl th, .evtbl td { text-align: left; padding: 6px 9px; border-bottom: 1px solid #eaeef2; font-size: 12px; vertical-align: top; }
  .evtbl th { background: #f6f8fa; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; color: #57606a; }
  .evtbl tr:last-child td { border-bottom: none; }
  .src { font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 3px; text-transform: uppercase; }
  .src-atom { background: #d1fadf; color: #0a7c42; }
  .src-pattern { background: #eaeef2; color: #57606a; }
  .src-mcp { background: #dbeafe; color: #1e40af; }
  table.all-skills { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; }
  table.all-skills td { padding: 0; }
  .skill-row { border-bottom: 1px solid #eaeef2; }
  .skill-row:last-child { border-bottom: none; }
  table.all-skills details summary { list-style: none; padding: 8px 13px; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  table.all-skills details summary::-webkit-details-marker { display: none; }
  table.all-skills details[open] summary { background: #f6f8fa; border-bottom: 1px solid #eaeef2; }
  .lr-desc { color: #57606a; font-size: 12.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { padding: 11px 15px; }
  .hz-list { margin-top: 8px; }
  .hz-blk { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 15px; margin: 10px 0; }
  .hz-h { font-size: 13.5px; font-weight: 650; margin-bottom: 2px; }
  .hid { font-family: ui-monospace, monospace; font-weight: 700; color: #8c959f; font-size: 10.5px; letter-spacing: .03em; }
  .hz-blk details { margin: 4px 0; }
  .hz-blk summary { cursor: pointer; font-size: 12.5px; color: #57606a; font-weight: 600; }
  .hz-blk ul { margin: 5px 0 8px; padding-left: 18px; }
  .hz-blk li { font-size: 12px; }
  .pair { margin-top: 6px; }
  .role { font-size: 11px; color: #57606a; font-weight: 650; text-transform: uppercase; letter-spacing: .03em; }
  footer { margin-top: 46px; padding-top: 15px; border-top: 1px solid #d0d7de; color: #8c959f; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(report.product)}</h1>
    <div class="q">What each skill can do, what it does that its description doesn't mention, and what to do about it.</div>
    <div class="dir">scanned: ${esc(dir)}</div>
    <div class="posture">${esc(POSTURE_PLAIN[p.tier])}</div>
    ${banner}
  </header>

  ${actionSummary(report)}

  ${statsHtml}
  <p class="muted" style="font-size:13px">${esc(surfaceParts.join(" &middot; "))}.</p>
${sectionsHtml}

  <h2>How skills combine <span class="sub">(only matters when two run in one agent)</span></h2>
  ${appendix(report)}

  <footer>Generated by ${esc(report.product)} on ${esc(generated)}. A first-pass scan is a cautious prior, not a confirmed exploit — treat findings as &ldquo;review or gate,&rdquo; not &ldquo;malicious.&rdquo;</footer>
</div>
</body>
</html>`;
}
