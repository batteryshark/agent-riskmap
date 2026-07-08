/**
 * Live MCP server introspection — the "no source code" path.
 *
 * Given an MCP server config (stdio command or a remote URL), connect as a CLIENT
 * and capture everything observable over the wire — protocol revision, server
 * info + instructions, advertised capabilities, and the full tool / prompt /
 * resource / template surface (optionally resource bodies). We NEVER invoke a
 * tool; only `initialize`, the `list` methods, and `resources/read`. Secrets are scrubbed
 * from every captured string. This is the *advertised* surface — a snapshot a
 * remote server can change per-call and per-caller (see delegated-trust).
 *
 * The MCP SDK is an OPTIONAL dependency, imported lazily so the static scanner
 * stays zero-dependency; probing errors clearly if it isn't installed.
 */

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  source: string; // "tools/list" | "meta-tool:<name>"
}
export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}
export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}
export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ServerManifest {
  id: string;
  transport: McpTransportKind;
  endpoint: string; // scrubbed command line or URL (no userinfo / tokens)
  connected: boolean;
  error?: string;
  protocolVersion?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
  instructions?: string;
  capabilities: Record<string, unknown>;
  tools: McpTool[];
  prompts: McpPrompt[];
  resources: McpResource[];
  resourceTemplates: McpResourceTemplate[];
  resourceBodies: Array<{ uri: string; mimeType?: string; text: string; truncated: boolean }>;
  /** What the server tried to do to US during the probe (client-capability abuse). */
  observed: {
    sampling: Array<{ intent: string }>; // server asked to run YOUR model (what it wanted, scrubbed)
    elicitation: Array<{ message: string }>; // server asked to prompt YOUR user
    rootsRequested: number; // server asked for your filesystem roots
  };
  /** The headers/identity presented — the surface can differ per caller. */
  presentedHeaders: string[];
  completeness: { complete: boolean; notes: string[] };
}

export interface ProbeOptions {
  readResources?: boolean;
  /** Drive a detected tool-search / meta-tool to enumerate hidden tools (read-only
   * discovery, but it DOES call the search tool — hence opt-in). */
  driveSearch?: boolean;
  maxResources?: number;
  maxResourceBytes?: number;
  maxItems?: number;
  timeoutMs?: number;
  /** Known secret values (from headers/env) to redact from all captured text. */
  secrets?: string[];
}

const DEFAULTS = { maxResources: 25, maxResourceBytes: 20_000, maxItems: 500, timeoutMs: 30_000 };

// Tool names that look like a progressive-disclosure / dynamic tool-search meta-tool:
// the real operations hide behind them and never appear in tools/list.
const META_TOOL_HINTS = [/tool[_-]?search/i, /search[_-]?tools?/i, /discover[_-]?tools?/i, /list[_-]?tools?/i, /find[_-]?tools?/i];

function stripUserinfo(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|auth|sig|password/i.test(k)) u.searchParams.set(k, "«redacted»");
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Redact known secret values + common token shapes from captured text. */
export function makeScrubber(secrets: string[] = []): (v: unknown) => string {
  const vals = secrets.filter((s) => s && s.length >= 6);
  const patterns = [
    /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9._-]{20,}\b/g, // JWT
  ];
  return (v: unknown): string => {
    let s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    for (const val of vals) s = s.split(val).join("«redacted»");
    for (const re of patterns) s = s.replace(re, "«redacted»");
    return s;
  };
}

async function loadSdk(): Promise<any> {
  try {
    const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, { SSEClientTransport }, types] =
      await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/stdio.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/client/sse.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
    return { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, types };
  } catch {
    throw new Error(
      "live MCP probing needs the optional peer '@modelcontextprotocol/sdk' — install it: npm i @modelcontextprotocol/sdk",
    );
  }
}

/** Best-effort drive of a tool-search meta-tool to reveal hidden tools (read-only). */
async function driveMetaTool(client: any, metaName: string, scrub: (v: unknown) => string, cap: number): Promise<McpTool[]> {
  const argShapes = [{}, { query: "" }, { q: "" }, { query: "*" }, { search: "" }];
  for (const args of argShapes) {
    try {
      const res = await client.callTool({ name: metaName, arguments: args });
      const found = extractToolDefs(res);
      if (found.length) return found.slice(0, cap).map((t) => scrubTool(t, `meta-tool:${metaName}`, scrub));
    } catch { /* try next shape */ }
  }
  return [];
}

/** Pull tool-like objects ({name, description/inputSchema}) from a tool-call result. */
function extractToolDefs(res: any): any[] {
  const out: any[] = [];
  const consider = (v: any) => { if (v && typeof v === "object" && typeof v.name === "string" && ("description" in v || "inputSchema" in v || "input_schema" in v)) out.push(v); };
  const walk = (v: any, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") { consider(v); for (const x of Object.values(v)) walk(x, depth + 1); }
  };
  walk(res?.structuredContent);
  for (const c of res?.content ?? []) {
    if (c?.type === "text" && typeof c.text === "string") { try { walk(JSON.parse(c.text)); } catch { /* not json */ } }
  }
  return out;
}

function transportKind(cfg: McpServerConfig): McpTransportKind {
  const t = (cfg.transport || "").toLowerCase();
  if (t === "sse") return "sse";
  if (t.includes("http") || t.includes("stream")) return "http";
  if (cfg.command) return "stdio";
  if (cfg.url) return "http";
  return "stdio";
}

async function collectPaged(
  list: (cursor?: string) => Promise<{ items: any[]; nextCursor?: string }>,
  cap: number,
): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  do {
    const { items, nextCursor } = await list(cursor);
    out.push(...items);
    cursor = nextCursor;
  } while (cursor && out.length < cap);
  return out.slice(0, cap);
}

/** Connect to one MCP server and capture its advertised surface. */
export async function probeServer(id: string, cfg: McpServerConfig, opts: ProbeOptions = {}): Promise<ServerManifest> {
  const o = { ...DEFAULTS, ...opts };
  const scrub = makeScrubber(opts.secrets ?? [
    ...Object.values(cfg.headers ?? {}),
    ...Object.values(cfg.env ?? {}),
  ]);
  const kind = transportKind(cfg);
  const endpoint = kind === "stdio"
    ? scrub([cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(" "))
    : stripUserinfo(cfg.url ?? "");

  const manifest: ServerManifest = {
    id, transport: kind, endpoint, connected: false,
    capabilities: {}, tools: [], prompts: [], resources: [], resourceTemplates: [],
    resourceBodies: [],
    observed: { sampling: [], elicitation: [], rootsRequested: 0 },
    presentedHeaders: Object.keys(cfg.headers ?? {}),
    completeness: { complete: true, notes: [] },
  };

  const sdk = await loadSdk();
  let transport: any;
  if (kind === "stdio") {
    if (!cfg.command) { manifest.error = "stdio server has no command"; return manifest; }
    transport = new sdk.StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: { ...process.env, ...cfg.env } });
  } else if (kind === "sse") {
    transport = new sdk.SSEClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });
  } else {
    transport = new sdk.StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers: cfg.headers } });
  }

  // Capture the negotiated protocol version — the Client calls setProtocolVersion
  // after initialize on every transport, but only HTTP/SSE retain it, so we hook it.
  let negotiatedProtocol: string | undefined;
  const origSet = typeof transport.setProtocolVersion === "function" ? transport.setProtocolVersion.bind(transport) : undefined;
  transport.setProtocolVersion = (v: string) => { negotiatedProtocol = v; origSet?.(v); };

  // Advertise the client capabilities a server could abuse (sampling / elicitation /
  // roots) and RECORD any request the server makes during the read-only probe —
  // returning a safe canned reply so no real inference / user prompt is exposed.
  const client = new sdk.Client(
    { name: "agent-riskmap", version: "0" },
    { capabilities: { sampling: {}, elicitation: {}, roots: { listChanged: true } } },
  );
  try {
    client.setRequestHandler(sdk.types.CreateMessageRequestSchema, async (req: any) => {
      const msgs = req.params?.messages ?? [];
      const intent = scrub([req.params?.systemPrompt, ...msgs.map((m: any) => (typeof m?.content?.text === "string" ? m.content.text : JSON.stringify(m?.content)))].filter(Boolean).join(" | ")).slice(0, 300);
      manifest.observed.sampling.push({ intent });
      return { role: "assistant", content: { type: "text", text: "[declined: agent-riskmap probe does not run inference for servers]" }, model: "agent-riskmap-probe", stopReason: "endTurn" };
    });
    client.setRequestHandler(sdk.types.ElicitRequestSchema, async (req: any) => {
      manifest.observed.elicitation.push({ message: scrub(req.params?.message ?? "").slice(0, 200) });
      return { action: "decline" };
    });
    client.setRequestHandler(sdk.types.ListRootsRequestSchema, async () => {
      manifest.observed.rootsRequested++;
      return { roots: [] };
    });
  } catch { /* schemas unavailable on older SDKs — probe still works without capture */ }

  try {
    await client.connect(transport);
  } catch (e) {
    manifest.error = scrub(e instanceof Error ? e.message : String(e));
    try { await client.close?.(); } catch { /* ignore */ }
    return manifest;
  }

  try {
    manifest.connected = true;
    manifest.protocolVersion = negotiatedProtocol ?? transport.protocolVersion ?? undefined;
    manifest.serverInfo = client.getServerVersion?.();
    manifest.instructions = client.getInstructions?.() ? scrub(client.getInstructions()) : undefined;
    const caps = client.getServerCapabilities?.() ?? {};
    manifest.capabilities = caps;

    if (caps.tools) {
      const raw = await collectPaged(async (cursor) => {
        const r = await client.listTools(cursor ? { cursor } : undefined);
        return { items: r.tools ?? [], nextCursor: r.nextCursor };
      }, o.maxItems);
      manifest.tools = raw.map((t: any) => scrubTool(t, "tools/list", scrub));

      // Progressive-disclosure / tool-search meta-tool: a server FEATURE (not a client
      // convention) that hides the real tools behind a search op. We flag it, and —
      // when driveSearch is set — drive it (read-only discovery) to reveal them.
      const meta = raw.find((t: any) => META_TOOL_HINTS.some((re) => re.test(t.name)));
      if (meta && opts.driveSearch) {
        const hidden = await driveMetaTool(client, meta.name, scrub, o.maxItems);
        if (hidden.length) {
          const seen = new Set(manifest.tools.map((t) => t.name));
          const fresh = hidden.filter((t) => !seen.has(t.name));
          manifest.tools.push(...fresh);
          manifest.completeness.notes.push(`drove tool-search meta-tool "${meta.name}" → ${fresh.length} additional tool(s) revealed`);
        } else {
          manifest.completeness.complete = false;
          manifest.completeness.notes.push(`tool-search meta-tool "${meta.name}" could not be enumerated — surface is partial`);
        }
      } else if (meta) {
        manifest.completeness.complete = false;
        manifest.completeness.notes.push(`a tool-search / meta-tool ("${meta.name}") may hide tools not in tools/list — re-run with --drive-search to enumerate`);
      }
      if (caps.tools?.listChanged) manifest.completeness.notes.push("server advertises tools.listChanged — the tool set can change at runtime");
    }
    if (caps.prompts) {
      const raw = await collectPaged(async (cursor) => {
        const r = await client.listPrompts(cursor ? { cursor } : undefined);
        return { items: r.prompts ?? [], nextCursor: r.nextCursor };
      }, o.maxItems);
      manifest.prompts = raw.map((p: any) => ({
        name: p.name, title: p.title, description: p.description ? scrub(p.description) : undefined, arguments: p.arguments,
      }));
    }
    if (caps.resources) {
      const raw = await collectPaged(async (cursor) => {
        const r = await client.listResources(cursor ? { cursor } : undefined);
        return { items: r.resources ?? [], nextCursor: r.nextCursor };
      }, o.maxItems);
      manifest.resources = raw.map((r: any) => ({
        uri: r.uri, name: r.name, title: r.title, description: r.description ? scrub(r.description) : undefined, mimeType: r.mimeType,
      }));
      const tmpl = await client.listResourceTemplates?.().catch(() => ({ resourceTemplates: [] }));
      manifest.resourceTemplates = (tmpl?.resourceTemplates ?? []).map((t: any) => ({
        uriTemplate: t.uriTemplate, name: t.name, description: t.description ? scrub(t.description) : undefined, mimeType: t.mimeType,
      }));

      if (opts.readResources) {
        for (const r of manifest.resources.slice(0, o.maxResources)) {
          try {
            const got = await client.readResource({ uri: r.uri });
            for (const c of got.contents ?? []) {
              if (typeof c.text === "string") {
                const truncated = c.text.length > o.maxResourceBytes;
                manifest.resourceBodies.push({ uri: r.uri, mimeType: c.mimeType, text: scrub(c.text.slice(0, o.maxResourceBytes)), truncated });
              }
            }
          } catch { /* resource may be gated; skip */ }
        }
      }
    }
  } catch (e) {
    manifest.error = scrub(e instanceof Error ? e.message : String(e));
  } finally {
    try { await client.close?.(); } catch { /* ignore */ }
  }
  return manifest;
}

function scrubTool(t: any, source: string, scrub: (v: unknown) => string): McpTool {
  return {
    name: t.name,
    title: t.title,
    description: t.description ? scrub(t.description) : undefined,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: t.annotations,
    source,
  };
}
