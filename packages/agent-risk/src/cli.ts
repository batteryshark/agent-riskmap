#!/usr/bin/env node
/**
 * agent-risk CLI:  agent-risk <dir> [--json]
 * Default prints a human summary of dangerous combinations; --json emits the full report.
 */

import { workflow } from "./product.js";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: agent-risk <dir> [--json]");
    return 1;
  }

  const report = workflow(dir);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

  console.log(bold("agent-risk") + dim(`  —  ${report.question}`));
  console.log(`\n${bold(report.headline)}`);
  console.log(
    dim(
      `${report.toolCount} tools scanned · ${report.summary.capable} capable · ${report.summary.steerable} steerable · ${report.summary.inert} inert`,
    ),
  );
  console.log(`posture: ${bold(report.posture.tier)} — ${report.posture.headline}\n`);

  for (const c of report.combos) {
    const dangerous = c.selfSufficient.length > 0 || c.crossPairs > 0;
    if (!dangerous) continue;
    console.log(`${red("▲ " + c.id)}  ${dim(c.label)}`);
    if (c.selfSufficient.length) {
      console.log(`    ${yellow("self-sufficient")} (completes it alone): ${c.selfSufficient.join(", ")}`);
    }
    if (c.crossPairs > 0) {
      console.log(`    ${yellow("cross-skill")} (${c.crossPairs} pairing${c.crossPairs !== 1 ? "s" : ""}):`);
      console.log(`      source: ${c.sourceOnly.join(", ")}`);
      console.log(`      sink:   ${c.sinkOnly.join(", ")}`);
    }
  }

  if (report.overview.counts.selfSufficientTargets === 0 && report.overview.counts.crossSkillPairings === 0) {
    console.log(dim("No EXFIL / RCE / DROP compositions found."));
  }

  console.log(`\n${bold("recommendations")}`);
  for (const r of report.recommendations) console.log(`  · ${r}`);
  return 0;
}

process.exit(main(process.argv));
