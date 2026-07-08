/**
 * Load an MCP config (`{ "mcpServers": { … } }`, or a single server object) and
 * resolve `${VAR}` references from the environment + an optional secrets file. The
 * resolved secret values are returned so the probe can scrub them from artifacts.
 */

import { readFileSync } from "node:fs";
import type { McpServerConfig } from "./probe.js";

export interface LoadedServer {
  id: string;
  config: McpServerConfig;
}

export interface LoadedConfig {
  servers: LoadedServer[];
  secrets: string[]; // resolved secret values to scrub from captured text
}

function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function substitute(value: unknown, env: Record<string, string>, secrets: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      const v = env[name] ?? "";
      if (v) secrets.add(v);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((x) => substitute(x, env, secrets));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value)) o[k] = substitute(val, env, secrets);
    return o;
  }
  return value;
}

export function loadMcpConfig(path: string, opts: { secretsEnv?: string } = {}): LoadedConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const env = { ...(opts.secretsEnv ? parseDotenv(opts.secretsEnv) : {}), ...process.env } as Record<string, string>;
  const secrets = new Set<string>();

  let entries: Record<string, unknown>;
  if (raw && typeof raw === "object" && raw.mcpServers && typeof raw.mcpServers === "object") {
    entries = raw.mcpServers as Record<string, unknown>;
  } else if (raw && typeof raw === "object" && (raw.command || raw.url)) {
    entries = { default: raw };
  } else {
    entries = {};
  }

  const servers: LoadedServer[] = [];
  for (const [id, def] of Object.entries(entries)) {
    if (!def || typeof def !== "object") continue;
    servers.push({ id, config: substitute(def, env, secrets) as McpServerConfig });
  }
  // env values referenced by servers are secrets; also treat any header values as secret.
  for (const s of servers) for (const v of Object.values(s.config.headers ?? {})) if (v) secrets.add(v);

  return { servers, secrets: [...secrets] };
}
