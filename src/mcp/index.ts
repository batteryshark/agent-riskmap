/**
 * MCP live-scan: connect to every server in a config, introspect the advertised
 * surface (no source needed), and profile each along the risk dimensions —
 * including ⑧ delegated-trust. This closes the "remote / opaque MCP server"
 * blind spot the static scanner can't reach.
 */

import { loadMcpConfig } from "./config.js";
import { probeServer, type ServerManifest, type ProbeOptions } from "./probe.js";
import { profileFromManifest, type McpFindings } from "./analyze.js";
import { tierOfProfile, type Posture } from "../severity.js";
import { selfSufficientHazards, type HazardId } from "../hazards.js";
import type { DimensionProfile } from "../dimensions.js";

export { probeServer, type ServerManifest } from "./probe.js";
export { loadMcpConfig } from "./config.js";
export { analyzeManifest, profileFromManifest, classifyTool, poisonHits, type McpFindings } from "./analyze.js";

export interface McpServerReport {
  manifest: ServerManifest;
  findings: McpFindings;
  profile: DimensionProfile;
  posture: Posture;
  hazards: HazardId[];
}

/** Probe + analyze every server in an MCP config. */
export async function scanMcpConfig(
  configPath: string,
  opts: { secretsEnv?: string } & ProbeOptions = {},
): Promise<McpServerReport[]> {
  const { servers, secrets } = loadMcpConfig(configPath, { secretsEnv: opts.secretsEnv });
  const out: McpServerReport[] = [];
  for (const { id, config } of servers) {
    const manifest = await probeServer(id, config, { ...opts, secrets: [...secrets, ...(opts.secrets ?? [])] });
    const { profile, findings } = profileFromManifest(manifest);
    out.push({ manifest, findings, profile, posture: tierOfProfile(profile), hazards: selfSufficientHazards(profile) });
  }
  return out;
}

/** Human-readable summary of an MCP live-scan. */
export function renderMcpReport(reports: McpServerReport[]): string {
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const tierC = (t: string) => (t === "critical" ? red(t) : t === "elevated" ? yellow(t) : dim(t));
  const L: string[] = [];

  L.push(bold("agent-riskmap mcp") + dim("  —  live introspection of MCP servers (advertised surface; a snapshot that can change)"));
  for (const r of reports) {
    const f = r.findings;
    L.push("");
    if (!f.connected) { L.push(`${red("✗")} ${bold(f.server.id)}  ${dim(f.server.endpoint)}  — could not connect: ${f.error ?? "unknown"}`); continue; }
    L.push(`${tierC("● " + r.posture.tier.padEnd(8))} ${bold(f.server.id)}  ${dim(f.server.serverInfo?.name ?? "")} ${dim(f.server.serverInfo?.version ?? "")}`);
    L.push(dim(`   ${f.server.transport} · MCP ${f.server.protocolVersion ?? "?"} · capabilities: ${f.capabilities.join(", ") || "none"}`));
    L.push(dim(`   ${f.counts.tools} tools (${f.counts.write} write, ${red(String(f.counts.destructive) + " destructive")}, ${f.counts.openWorld} open-world, ${f.counts.unconstrained} unconstrained-param) · ${f.counts.prompts} prompts · ${f.counts.resources} resources`));
    if (r.hazards.length) L.push(`   ${cyan("⚑ hazards: " + r.hazards.join("/"))}`);
    if (r.profile.facets.size) L.push(`   ${yellow("delegated-trust:")} ${[...r.profile.facets].filter((x) => x.startsWith("trust:")).map((x) => x.split(":")[1]).join(", ")}`);
    if (f.poison.length) {
      L.push(`   ${red("⚠ tool-poisoning / injection surface:")}`);
      for (const p of f.poison.slice(0, 6)) L.push(`      ${p.where}: «${p.hit}»`);
    }
    if (f.externalHosts.length) L.push(dim(`   external hosts: ${f.externalHosts.slice(0, 8).join(", ")}`));
    if (!f.complete) L.push(yellow(`   ⚠ partial: ${f.notes.join("; ")}`));
    const destructive = f.tools.filter((t) => t.destructive).map((t) => t.name);
    if (destructive.length) L.push(dim(`   destructive tools: ${destructive.slice(0, 10).join(", ")}`));
  }
  L.push("");
  L.push(dim("Note: this is the advertised surface. Treat every captured string as untrusted; a hostile server can hide behavior or serve different content per caller. Do not grant sampling/elicitation to opaque servers."));
  return L.join("\n");
}
