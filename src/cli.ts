#!/usr/bin/env node
/**
 * agent-riskmap CLI:  agent-riskmap <dir> [--json]   (short alias: riskmap)
 * Profiles an agent surface along the seven risk dimensions, composes the six
 * hazards, and says what to restrict / prune / gate. --json emits the full report.
 */

import { workflow, scanSurface } from "./product.js";
import { renderHtml } from "./html.js";
import { mergeVerdicts } from "./triage.js";
import { loadState, loadStateFile } from "./ledger.js";
import { scanMcpConfig, renderMcpReport } from "./mcp/index.js";
import { resolve } from "node:path";
import type { TargetKind } from "./scan.js";

/** `agent-riskmap mcp <config.json>` — live-probe MCP servers (connects to them). */
async function runMcp(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const readResources = args.includes("--read-resources");
  const driveSearch = args.includes("--drive-search");
  const seIdx = args.indexOf("--secrets-env");
  const secretsEnv = seIdx !== -1 ? args[seIdx + 1] : undefined;
  const config = args.find((a, i) => !a.startsWith("--") && a !== "mcp" && args[i - 1] !== "--secrets-env");
  if (!config) {
    console.error("usage: agent-riskmap mcp <mcp-config.json> [--read-resources] [--drive-search] [--secrets-env <file>] [--json]");
    return 1;
  }
  console.error(`\x1b[2mconnecting to MCP server(s) in ${config}${readResources ? " (reading resource bodies)" : ""}${driveSearch ? " (driving tool-search)" : ""} — this launches/contacts each server${driveSearch ? " and calls its read-only search tool" : ", never invokes tools"}…\x1b[0m`);
  const reports = await scanMcpConfig(config, { secretsEnv, readResources, driveSearch });
  if (json) {
    console.log(JSON.stringify(reports.map((r) => ({ ...r.findings, tier: r.posture.tier, hazards: r.hazards, manifest: r.manifest })), null, 2));
    return 0;
  }
  console.log(renderMcpReport(reports));
  return 0;
}

const KIND_LABEL: Record<TargetKind, string> = { skill: "skills", mcp: "mcp", tool: "tools", hooks: "hooks", prompt: "prompts" };

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const html = args.includes("--html");
  const connect = args.includes("--connect");
  const seIdx = args.indexOf("--secrets-env");
  const ledgerIdx = args.indexOf("--ledger");
  const useLedger = ledgerIdx !== -1;
  const ledgerPathArg = useLedger && args[ledgerIdx + 1] && !args[ledgerIdx + 1]!.startsWith("--") ? args[ledgerIdx + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith("--") && a !== ledgerPathArg && args[i - 1] !== "--secrets-env");
  if (!dir) {
    console.error("usage: agent-riskmap <dir> [--connect] [--read-resources] [--drive-search] [--json] [--html] [--ledger [state.json]]");
    return 1;
  }

  if (connect) console.error("\x1b[2m--connect: live-probing MCP servers declared in this surface's configs (connects to them)…\x1b[0m");
  let report = connect
    ? await scanSurface(dir, { connect: true, readResources: args.includes("--read-resources"), driveSearch: args.includes("--drive-search"), secretsEnv: seIdx !== -1 ? args[seIdx + 1] : undefined })
    : workflow(dir);

  // Merge triage verdicts when asked, so --html renders the reviewed picture.
  if (useLedger) {
    const state = ledgerPathArg ? loadStateFile(ledgerPathArg) : loadState(resolve(dir));
    if (!state) {
      console.error(`ledger: no state found${ledgerPathArg ? ` at ${ledgerPathArg}` : ` under ${dir}/.ledger`}.`);
      return 1;
    }
    report = mergeVerdicts(report, state);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  if (html) {
    console.log(renderHtml(report, dir));
    return 0;
  }

  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const tierColor = (t: string) => (t === "critical" ? red(t) : t === "elevated" ? yellow(t) : dim(t));

  console.log(bold("agent-riskmap") + dim(`  —  ${report.question}`));

  const surface = (Object.entries(report.surface) as Array<[TargetKind, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND_LABEL[k]}`)
    .join(" · ");
  console.log(dim(`\nsurface: ${surface || "nothing recognized"}`));

  console.log(`\n${bold(report.headline)}`);
  console.log(dim(`${report.toolCount} skills · ${report.summary.capable} capable · ${report.summary.steerable} steerable · ${report.summary.inert} no-signal`));
  console.log(`posture: ${tierColor(report.posture.tier)} — ${report.posture.headline}\n`);

  // Hazards with any composition.
  for (const h of report.hazards) {
    if (h.selfSufficient.length === 0 && h.crossPairs === 0) continue;
    console.log(`${red("▲ " + h.id)}  ${dim(h.label)}`);
    if (h.selfSufficient.length) console.log(`    ${yellow("self-sufficient")}: ${h.selfSufficient.join(", ")}`);
    if (h.crossPairs > 0) {
      console.log(`    ${yellow("cross-skill")} (${h.crossPairs} pairing${h.crossPairs !== 1 ? "s" : ""}):`);
      console.log(`      ${h.aName}: ${h.aOnly.join(", ")}`);
      console.log(`      ${h.bName}: ${h.bOnly.join(", ")}`);
    }
  }
  if (report.overview.counts.selfSufficientTargets === 0 && report.overview.counts.crossSkillPairings === 0) {
    console.log(dim("No hazard compositions found."));
  }

  // The riskiest skills by tier (the map).
  const rank = (t: string) => (t === "critical" ? 0 : t === "elevated" ? 1 : 2);
  const risky = report.targets
    .filter((t) => t.tier === "critical" || t.tier === "elevated")
    .sort((a, b) => rank(a.tier) - rank(b.tier) || a.target.localeCompare(b.target));
  if (risky.length) {
    console.log(`\n${bold("riskiest skills")}`);
    for (const t of risky.slice(0, 15)) {
      console.log(`  ${tierColor(t.tier.padEnd(8))} ${t.target}  ${dim(t.dimensions.join(", "))}${t.hazards.length ? cyan("  ⚑ " + t.hazards.join("/")) : ""}`);
    }
    if (risky.length > 15) console.log(dim(`  … and ${risky.length - 15} more`));
  }

  console.log(`\n${bold("what to do")}`);
  for (const r of report.recommendations) {
    const tag = r.action === "ok" ? dim("[ok]") : cyan(`[${r.action}]`);
    console.log(`  ${tag} ${r.text}`);
  }
  return 0;
}

const entry = process.argv[2] === "mcp" ? runMcp(process.argv.slice(2)) : main(process.argv);
entry.then(
  (code) => process.exit(code),
  (e) => { console.error(`${e instanceof Error ? e.message : String(e)}`); process.exit(1); },
);
