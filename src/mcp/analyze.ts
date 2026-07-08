/**
 * Turn a captured MCP server manifest into a dimension profile + MCP-specific
 * findings. Treat EVERY captured string as untrusted data, never instructions.
 *
 * The advertised tool surface is *strong* evidence (a tool named `delete_file`
 * with `destructiveHint` is real capability, not a prose mention), so hints are
 * emitted with source "mcp". An opaque, live server is inherently delegated-trust;
 * `listChanged` / remote transport make it volatile; hidden-instruction or
 * invisible-unicode text is a poisoning (steerability) surface.
 */

import { buildProfile, type DimHint, type DimensionProfile } from "../dimensions.js";
import type { ServerManifest, McpTool } from "./probe.js";

const DESTRUCTIVE_VERBS = new Set(["delete", "remove", "drop", "truncate", "purge", "destroy", "wipe", "overwrite", "reset", "revoke", "cancel", "close"]);
const WRITE_VERBS = new Set(["create", "update", "write", "upload", "send", "post", "publish", "add", "set", "modify", "insert", "save", "import", "apply", "move", "rename", "merge"]);
const OUTBOUND_VERBS = new Set(["send", "post", "publish", "upload", "share", "email", "message", "notify", "dispatch"]);
const EGRESS_PARAMS = new Set(["url", "uri", "endpoint", "host", "webhook", "webhook_url", "callback", "server"]);
const PATH_PARAMS = new Set(["path", "file", "filename", "filepath", "file_path", "dir", "directory"]);
const CODE_PARAMS = new Set(["sql", "query", "command", "cmd", "code", "script", "expression", "shell", "eval", "program", "statement"]);

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const POISON_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|preceding)\s+(instruction|prompt|context)/i,
  /disregard\s+(the\s+)?(above|previous|prior|system)/i,
  /do\s+not\s+(tell|inform|mention|notify|reveal|disclose)[^.\n]{0,40}\b(user|operator|human)\b/i,
  /without\s+(telling|informing|notifying|alerting)\s+(the\s+)?(user|operator)/i,
  /<\s*important\s*>/i,
  /<\|?(system|im_start|im_end)\|?>/i,
  /\byou\s+must\s+(always\s+|first\s+)?(call|use|invoke|run)\b/i,
];

const URL_RE = /https?:\/\/([A-Za-z0-9.\-]+)/g;

export function poisonHits(text: string | undefined): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const re of POISON_PATTERNS) { const m = re.exec(text); if (m) hits.push(m[0].trim().slice(0, 50)); }
  if (INVISIBLE.test(text)) hits.push("invisible/bidi unicode");
  return hits;
}

function verbOf(name: string): string {
  return (name.split(/[_\-.\s]/)[0] || "").toLowerCase();
}

export interface ToolVerdict {
  name: string;
  readOnly: boolean;
  write: boolean;
  destructive: boolean;
  openWorld: boolean;
  unconstrained: string[];
  poison: string[];
}

function unconstrainedParams(schema: unknown): string[] {
  const props = (schema as any)?.properties;
  if (!props || typeof props !== "object") return [];
  const out: string[] = [];
  for (const [name, specRaw] of Object.entries(props)) {
    const spec = (specRaw ?? {}) as any;
    const key = name.toLowerCase();
    if (!EGRESS_PARAMS.has(key) && !PATH_PARAMS.has(key) && !CODE_PARAMS.has(key)) continue;
    const typ = spec.type;
    const isStr = typ === "string" || typ == null || (Array.isArray(typ) && typ.includes("string"));
    if (isStr && !("format" in spec) && !("enum" in spec) && !("pattern" in spec)) out.push(name);
  }
  return out;
}

export function classifyTool(t: McpTool): ToolVerdict {
  const ann = (t.annotations ?? {}) as Record<string, unknown>;
  const verb = verbOf(t.name);
  const destructive = ann.destructiveHint === true || DESTRUCTIVE_VERBS.has(verb);
  const write = ann.readOnlyHint === false || destructive || WRITE_VERBS.has(verb);
  return {
    name: t.name,
    readOnly: ann.readOnlyHint === true,
    write,
    destructive,
    openWorld: ann.openWorldHint === true,
    unconstrained: unconstrainedParams(t.inputSchema),
    poison: poisonHits(t.description),
  };
}

export interface McpFindings {
  server: { id: string; endpoint: string; transport: string; protocolVersion?: string; serverInfo?: ServerManifest["serverInfo"] };
  connected: boolean;
  error?: string;
  capabilities: string[];
  counts: { tools: number; write: number; destructive: number; openWorld: number; unconstrained: number; prompts: number; resources: number; templates: number };
  tools: ToolVerdict[];
  poison: Array<{ where: string; hit: string }>;
  externalHosts: string[];
  /** What the server tried to do to the client during the probe. */
  observed: { sampling: number; elicitation: number; rootsRequested: number };
  presentedHeaders: string[];
  volatile: boolean;
  complete: boolean;
  notes: string[];
}

/** Deterministic risk read of a captured surface + the dimension hints it implies. */
export function analyzeManifest(m: ServerManifest): { findings: McpFindings; hints: DimHint[] } {
  const hints: DimHint[] = [];
  const poison: Array<{ where: string; hit: string }> = [];
  const hosts = new Set<string>();
  const noteHosts = (text?: string) => { if (!text) return; for (const mm of text.matchAll(URL_RE)) if (mm[1]) hosts.add(mm[1]); };

  const push = (dimension: DimHint["dimension"], facet: DimHint["facet"], evidence: string, detail: string, path?: string) =>
    hints.push({ dimension, facet, source: "mcp", detail, evidence: evidence.slice(0, 60), path });

  // Every live-probed server is an opaque, delegated third party.
  push("delegated-trust", "trust:opaque", m.endpoint || m.id, "opaque-server");
  const volatile = !m.completeness.complete || m.transport !== "stdio"
    || Object.values(m.capabilities as Record<string, any>).some((c) => c && typeof c === "object" && c.listChanged);
  if (volatile) push("delegated-trust", "trust:volatile", "advertised surface can change", "volatile");

  // Server instructions are injected trusted context.
  noteHosts(m.instructions);
  for (const h of poisonHits(m.instructions)) { poison.push({ where: "server.instructions", hit: h }); push("steerability", undefined, h, "poison"); push("delegated-trust", "trust:poisoning", h, "poison", "server.instructions"); }

  const verdicts = m.tools.map(classifyTool);
  for (const t of m.tools) {
    noteHosts(t.description);
    const v = classifyTool(t);
    if (v.destructive) push("authority", "authority:destructive", `tool ${t.name}`, "destructive-tool");
    if (v.write) push("authority", OUTBOUND_VERBS.has(verbOf(t.name)) ? "authority:outbound" : undefined, `tool ${t.name}`, "write-tool");
    if (v.openWorld) { push("reach", "reach:egress", `tool ${t.name} (open-world)`, "open-world-tool"); push("steerability", undefined, `tool ${t.name} pulls open-world content`, "open-world"); }
    for (const p of v.unconstrained) {
      const key = p.toLowerCase();
      if (EGRESS_PARAMS.has(key)) push("reach", "reach:egress", `${t.name}.${p} (unconstrained)`, "ssrf-param");
      else if (CODE_PARAMS.has(key)) push("latent", undefined, `${t.name}.${p} (unconstrained ${key})`, "injection-param");
      else push("data", "data:sensitive", `${t.name}.${p} (path traversal)`, "path-param");
    }
    for (const h of v.poison) { poison.push({ where: `tool:${t.name}`, hit: h }); push("steerability", undefined, h, "poison", `tool:${t.name}`); push("delegated-trust", "trust:poisoning", h, "poison", `tool:${t.name}`); }
  }

  // Prompt templates + resource bodies are server-controlled content the model trusts.
  for (const p of m.prompts) for (const h of poisonHits(p.description)) { poison.push({ where: `prompt:${p.name}`, hit: h }); push("delegated-trust", "trust:poisoning", h, "poison", `prompt:${p.name}`); push("steerability", undefined, h, "poison"); }
  for (const b of m.resourceBodies) { noteHosts(b.text); for (const h of poisonHits(b.text)) { poison.push({ where: `resource:${b.uri}`, hit: h }); push("delegated-trust", "trust:poisoning", h, "poison", `resource:${b.uri}`); push("steerability", undefined, h, "poison"); } }

  // Observed client-capability abuse: the server drove YOUR inference / user during
  // the probe. Sampling = the server can make your agent think/act on its behalf.
  for (const s of m.observed.sampling) push("delegated-trust", "trust:sampling", `requested sampling: ${s.intent}`, "sampling");
  if (m.observed.sampling.length) {
    push("latent", undefined, "server can drive your inference (MCP sampling)", "sampling");
    push("steerability", undefined, "server-authored prompts fed to your model", "sampling");
  }
  for (const e of m.observed.elicitation) push("delegated-trust", "trust:elicitation", `prompted your user: ${e.message}`, "elicitation");
  if (m.observed.elicitation.length) push("authority", undefined, "server can prompt your user (MCP elicitation)", "elicitation");

  for (const h of hosts) push("reach", "reach:egress", `external host ${h}`, "external-host");

  const findings: McpFindings = {
    server: { id: m.id, endpoint: m.endpoint, transport: m.transport, protocolVersion: m.protocolVersion, serverInfo: m.serverInfo },
    connected: m.connected,
    error: m.error,
    capabilities: Object.keys(m.capabilities),
    counts: {
      tools: verdicts.length,
      write: verdicts.filter((v) => v.write).length,
      destructive: verdicts.filter((v) => v.destructive).length,
      openWorld: verdicts.filter((v) => v.openWorld).length,
      unconstrained: verdicts.filter((v) => v.unconstrained.length).length,
      prompts: m.prompts.length,
      resources: m.resources.length,
      templates: m.resourceTemplates.length,
    },
    tools: verdicts,
    poison,
    externalHosts: [...hosts].sort(),
    observed: { sampling: m.observed.sampling.length, elicitation: m.observed.elicitation.length, rootsRequested: m.observed.rootsRequested },
    presentedHeaders: m.presentedHeaders,
    volatile,
    complete: m.completeness.complete,
    notes: m.completeness.notes,
  };
  return { findings, hints };
}

/** Build a dimension profile for a probed MCP server (reuses the shared profile). */
export function profileFromManifest(m: ServerManifest): { profile: DimensionProfile; findings: McpFindings } {
  const { findings, hints } = analyzeManifest(m);
  const label = m.serverInfo?.name ? `${m.id} (${m.serverInfo.name})` : m.id;
  const profile = buildProfile(m.id, "mcp", {}, [], hints, label);
  return { profile, findings };
}
