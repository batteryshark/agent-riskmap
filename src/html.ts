/**
 * Self-contained HTML report renderer — skill-centric and plain-English.
 *
 * The report is written for a decision-maker, not a security engineer: each skill
 * leads with what it claims to do, what it can actually do in plain terms, the risk
 * you would be accepting, and what to do about it (turn off / gate / keep). The
 * capability-combination matrix is an appendix, because it only matters once two
 * skills are co-enabled in one agent. Inline CSS, one script for collapsible rows,
 * no external assets.
 */

import type { AgentRiskReport, TargetReport } from "./product.js";
import type { Tier } from "./severity.js";
import type { Dimension, Facet } from "./dimensions.js";
import type { HazardId } from "./hazards.js";
import type { TargetKind } from "./scan.js";
import { DIM_PLAIN, FACET_PLAIN, HAZARD_PLAIN, MULTIPLIER_PLAIN } from "./plain.js";

const KIND_LABEL: Record<TargetKind, string> = {
  skill: "skills", mcp: "mcp", tool: "tools", hooks: "hooks", prompt: "prompts",
};

const TIER_HEX: Record<Tier, string> = {
  critical: "#b91c1c",
  elevated: "#b45309",
  moderate: "#1d4ed8",
  minimal: "#4b5563",
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

/** Plain "what it can do" line for a skill, preferring facets. */
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

function actionLabel(t: TargetReport): { verb: string; cls: string } {
  if (t.kind === "hooks") return { verb: "turn off (it runs automatically)", cls: "a-red" };
  if (t.tier === "critical") return { verb: "turn off, or gate behind approval", cls: "a-red" };
  if (t.tier === "elevated") return { verb: "gate behind approval before enabling", cls: "a-amber" };
  return { verb: "review before enabling", cls: "a-blue" };
}

function skillCard(t: TargetReport, recMap: Map<string, string>): string {
  const act = actionLabel(t);
  const rec = recMap.get(t.target);
  const caps = capabilityPhrases(t);
  const hazards = t.hazards;
  const mults = t.multipliers.filter((m) => m === "guardrail" || m === "steerability" || m === "persistence");

  const desc = t.description
    ? `<div class="desc"><span class="lbl">Says it:</span> ${esc(t.description)}</div>`
    : `<div class="desc"><span class="lbl">Says it:</span> <span class="muted">(no description declared)</span></div>`;

  const undisclosed = t.undisclosed.length
    ? `<div class="undisclosed">
         <span class="warn">⚠ May do more than its label suggests:</span>
         ${t.undisclosed.map((u) => `<span class="cap u">${esc(u)}</span>`).join("")}
       </div>`
    : "";

  const capsLine = caps.length
    ? `<div class="caps"><span class="lbl">Can actually:</span> ${caps.map((c) => `<span class="cap">${esc(c)}</span>`).join("")}</div>`
    : `<div class="caps"><span class="lbl">Can actually:</span> <span class="muted">no notable capability detected</span></div>`;

  const riskBits: string[] = hazards.map((h) => `<li>${esc(HAZARD_PLAIN[h])}</li>`);
  if (!hazards.length && caps.length) {
    riskBits.push(`<li>On its own it does not complete a full abuse path, but it is one half of one if paired with the wrong other skill (see the appendix).</li>`);
  }
  if (mults.length) {
    riskBits.push(`<li>It also ${mults.map((m) => esc(MULTIPLIER_PLAIN[m as "guardrail" | "steerability" | "persistence"])).join(" and ")}, which makes any of the above worse.</li>`);
  }
  const risk = riskBits.length
    ? `<div class="risk"><span class="lbl">Risk if abused:</span><ul>${riskBits.join("")}</ul></div>`
    : "";

  const verdict = t.verdict
    ? `<div class="verdict v-${esc(t.verdict.label || t.verdict.status)}">
         <span class="vtag">${esc(t.verdict.label || t.verdict.status)}</span>
         ${esc(t.verdict.result)}
       </div>`
    : "";

  const evidence = t.hints.length
    ? `<details class="ev"><summary>evidence (${t.hints.length})</summary>
         <table class="evtbl">
           <thead><tr><th>capability</th><th>source</th><th>matched</th><th>where</th></tr></thead>
           <tbody>${t.hints.map((h) => `<tr>
               <td>${esc((h.facet ? FACET_PLAIN[h.facet] : DIM_PLAIN[h.dimension]))}</td>
               <td><span class="src src-${h.source}">${h.source}</span></td>
               <td class="mono">${esc(h.evidence)}</td>
               <td class="mono">${h.path ? esc(h.path) : ""}${h.line ? `:${h.line}` : ""}</td>
             </tr>`).join("")}</tbody>
         </table>
       </details>`
    : "";

  return `<div class="card tier-${t.tier}">
      <div class="card-top">
        <span class="tier-dot" style="background:${TIER_HEX[t.tier]}"></span>
        <span class="tname mono">${esc(t.target)}</span>
        <span class="kbadge">${esc(t.kind)}</span>
        <span class="tier-badge" style="background:${TIER_HEX[t.tier]}">${esc(t.tier)}</span>
      </div>
      ${desc}${undisclosed}${capsLine}${risk}${verdict}
      <div class="do"><span class="lbl">What to do:</span> <span class="act ${act.cls}">${esc(act.verb)}</span>${rec ? ` — ${esc(rec)}` : ""}</div>
      ${evidence}
    </div>`;
}

function skillRow(t: TargetReport): string {
  const caps = capabilityPhrases(t);
  const desc = t.description ? esc(t.description) : `<span class="muted">(no description)</span>`;
  const undisclosed = t.undisclosed.length ? ` <span class="warn" title="${esc(t.undisclosed.join("; "))}">⚠ undisclosed</span>` : "";
  return `<tr class="skill-row"><td>
      <details>
        <summary>
          <span class="tier-dot" style="background:${TIER_HEX[t.tier]}"></span>
          <span class="mono tname">${esc(t.target)}</span>
          <span class="tier-badge sm" style="background:${TIER_HEX[t.tier]}">${esc(t.tier)}</span>
          <span class="lr-desc">${desc}${undisclosed}</span>
        </summary>
        <div class="detail">
          <div class="caps">${caps.length ? caps.map((c) => `<span class="cap">${esc(c)}</span>`).join("") : `<span class="muted">no notable capability</span>`}</div>
          ${t.hints.length ? `<table class="evtbl"><thead><tr><th>capability</th><th>source</th><th>matched</th><th>where</th></tr></thead>
            <tbody>${t.hints.map((h) => `<tr><td>${esc(h.facet ? FACET_PLAIN[h.facet] : DIM_PLAIN[h.dimension])}</td><td><span class="src src-${h.source}">${h.source}</span></td><td class="mono">${esc(h.evidence)}</td><td class="mono">${h.path ? esc(h.path) : ""}${h.line ? `:${h.line}` : ""}</td></tr>`).join("")}</tbody></table>` : ""}
        </div>
      </details>
    </td></tr>`;
}

function appendix(report: AgentRiskReport): string {
  const active = report.hazards.filter((h) => h.selfSufficient.length > 0 || h.crossPairs > 0);
  if (!active.length) return `<p class="muted">No cross-skill combinations found.</p>`;
  const blocks = active.map((h) => {
    const self = h.selfSufficient.length
      ? `<details><summary>self-sufficient on its own (${h.selfSufficient.length})</summary>
           <ul>${h.selfSufficient.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></details>`
      : "";
    const cross = h.crossPairs > 0
      ? `<details><summary>two-skill pairings (${h.crossPairs})</summary>
           <div class="pair"><span class="role">${esc(h.aName)}</span><ul>${h.aOnly.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></div>
           <div class="pair"><span class="role">${esc(h.bName)}</span><ul>${h.bOnly.map((t) => `<li class="mono">${esc(t)}</li>`).join("")}</ul></div></details>`
      : "";
    return `<div class="hz-blk">
        <div class="hz-h"><span class="hid">${esc(h.id)}</span> ${esc(HAZARD_PLAIN[h.id as HazardId])}</div>
        ${self}${cross}
      </div>`;
  });
  return `<p class="muted">These only matter when two skills run in the same agent. A skill in one column plus a skill in the other, together, complete an abuse path that neither does alone.</p>
    <div class="hz-list">${blocks.join("")}</div>`;
}

export function renderHtml(report: AgentRiskReport, dir: string): string {
  const p = report.posture;
  const generated = new Date().toISOString().replace("T", " ").replace(/\..+/, " UTC");

  const attention = report.targets.filter((t) => t.tier === "critical" || t.tier === "elevated")
    .sort((a, b) => rankTier(a.tier) - rankTier(b.tier) || a.target.localeCompare(b.target));
  const lower = report.targets.filter((t) => t.tier === "moderate" || t.tier === "minimal")
    .sort((a, b) => rankTier(a.tier) - rankTier(b.tier) || a.target.localeCompare(b.target));

  // index recommendations by the skill target they mention, for inline "what to do"
  const recMap = new Map<string, string>();
  for (const r of report.recommendations) {
    const m = r.text.match(/^([A-Z]+):\s+"([^"]+)"/);
    if (m && m[2]) recMap.set(m[2], r.text.replace(/^([A-Z]+):\s+"[^"]+"\s*/, ""));
  }

  const surfaceParts = (Object.entries(report.surface) as Array<[TargetKind, number]>)
    .filter(([, n]) => n > 0).map(([k, n]) => `${n} ${KIND_LABEL[k]}`);

  const reviewed = report.targets.some((t) => t.verdict);
  const banner = reviewed
    ? `<div class="banner ok">Reviewed report: ${report.targets.filter((t) => t.verdict).length}/${report.targets.length} skills have a triage verdict. Capability below reflects the model's read, not just the scan.</div>`
    : `<div class="banner">Draft report from the deterministic scan only. This is a pessimistic prior, not a verdict — run the triage loop for a reviewed picture.</div>`;

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
  .stats { display: flex; flex-wrap: wrap; gap: 26px; margin: 20px 0 4px; }
  .stat .n { font-size: 24px; font-weight: 750; line-height: 1; }
  .stat .l { color: #57606a; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; margin-top: 3px; }
  .muted { color: #6e7781; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  h2 { font-size: 16px; margin: 38px 0 4px; font-weight: 700; }
  h2 .sub { font-weight: 400; color: #6e7781; font-size: 13px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-left: 4px solid #d0d7de; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .card.tier-critical { border-left-color: ${TIER_HEX.critical}; }
  .card.tier-elevated { border-left-color: ${TIER_HEX.elevated}; }
  .card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 9px; }
  .tname { font-weight: 650; font-size: 14.5px; }
  .kbadge { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #8c959f;
            border: 1px solid #d0d7de; border-radius: 4px; padding: 0 5px; }
  .tier-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; }
  .tier-badge { color: #fff; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
                padding: 1px 7px; border-radius: 999px; margin-left: auto; }
  .tier-badge.sm { margin-left: 6px; font-size: 9.5px; }
  .lbl { color: #57606a; font-weight: 650; font-size: 12px; }
  .desc { font-size: 13.5px; margin: 3px 0; color: #24292f; }
  .caps { margin: 6px 0; }
  .cap { display: inline-block; background: #eaeef2; color: #24292f; padding: 1px 8px; border-radius: 5px;
         margin: 2px 3px 2px 0; font-size: 12.5px; }
  .cap.u { background: #fff1d6; color: #7a5200; }
  .undisclosed { margin: 7px 0; padding: 7px 10px; background: #fff8e6; border: 1px solid #f0d985; border-radius: 6px; }
  .warn { color: #9a6700; font-weight: 650; font-size: 12.5px; }
  .risk { margin: 8px 0; }
  .risk ul { margin: 4px 0 0; padding-left: 18px; }
  .risk li { font-size: 13px; margin: 3px 0; color: #24292f; }
  .do { margin: 9px 0 2px; font-size: 13.5px; }
  .act { font-weight: 700; }
  .act.a-red { color: #b91c1c; }
  .act.a-amber { color: #b45309; }
  .act.a-blue { color: #1d4ed8; }
  .verdict { margin: 8px 0; padding: 8px 10px; border-radius: 6px; font-size: 12.5px; background: #f6f8fa; border: 1px solid #d0d7de; }
  .vtag { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
          background: #d0d7de; color: #24292f; padding: 1px 6px; border-radius: 4px; margin-right: 6px; }
  .v-confirmed, .v-gated { background: #eafaf0; border-color: #9fe3c0; }
  .v-confirmed .vtag, .v-gated .vtag { background: #9fe3c0; color: #0a6b3b; }
  .v-dismissed { background: #f6f8fa; }
  .v-dismissed .vtag { background: #d0d7de; }
  .v-needs-human, .v-blocked { background: #ffeaea; border-color: #f3b6b6; }
  .v-needs-human .vtag, .v-blocked .vtag { background: #f3b6b6; color: #b91c1c; }
  details.ev, details summary { cursor: pointer; }
  details.ev > summary { font-size: 12px; color: #57606a; margin-top: 6px; }
  .evtbl { width: 100%; border-collapse: collapse; margin-top: 7px; border: 1px solid #eaeef2; border-radius: 6px; overflow: hidden; }
  .evtbl th, .evtbl td { text-align: left; padding: 6px 9px; border-bottom: 1px solid #eaeef2; font-size: 12px; vertical-align: top; }
  .evtbl th { background: #f6f8fa; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; color: #57606a; }
  .evtbl tr:last-child td { border-bottom: none; }
  .src { font-size: 9.5px; font-weight: 700; padding: 0 4px; border-radius: 3px; text-transform: uppercase; }
  .src-atom { background: #d1fADF; color: #0a7c42; }
  .src-pattern { background: #eaeef2; color: #57606a; }
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
  .hz-h { font-size: 13px; margin-bottom: 6px; }
  .hid { font-family: ui-monospace, monospace; font-weight: 700; color: #b91c1c; letter-spacing: .03em; }
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
    <div class="q">${esc(report.question)}</div>
    <div class="dir">scanned: ${esc(dir)}</div>
    <div class="posture">posture: ${esc(p.tier)}</div>
    ${banner}
  </header>

  <div class="stats">
    <div class="stat"><div class="n">${report.toolCount}</div><div class="l">skills</div></div>
    <div class="stat"><div class="n">${attention.length}</div><div class="l">need attention</div></div>
    <div class="stat"><div class="n">${report.overview.counts.selfSufficientTargets}</div><div class="l">self-sufficient</div></div>
    <div class="stat"><div class="n">${report.summary.steerable}</div><div class="l">steerable</div></div>
    <div class="stat"><div class="n">${report.summary.inert}</div><div class="l">no signal</div></div>
  </div>
  <p class="muted" style="font-size:13px">${esc(surfaceParts.join(" &middot; "))}. ${esc(report.headline)}</p>

  <h2>Skills that need your attention <span class="sub">(${attention.length})</span></h2>
  ${attention.length ? attention.map((t) => skillCard(t, recMap)).join("") : `<p class="muted">Nothing critical or elevated. Good shape.</p>`}

  <h2>Lower-risk skills <span class="sub">(${lower.length})</span></h2>
  ${lower.length ? `<table class="all-skills"><tbody>${lower.map(skillRow).join("")}</tbody></table>` : `<p class="muted">None.</p>`}

  <h2>Appendix: how skills can combine <span class="sub">(only matters when co-enabled)</span></h2>
  ${appendix(report)}

  <footer>Generated by ${esc(report.product)} on ${esc(generated)}. The scan is a pessimistic prior, not a confirmed exploit; treat findings as &ldquo;review or gate,&rdquo; not &ldquo;malicious.&rdquo;</footer>
</div>
</body>
</html>`;
}
