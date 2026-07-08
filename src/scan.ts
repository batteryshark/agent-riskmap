/**
 * Agent-surface discovery + per-target capability scan.
 *
 * A "target" is one element of the agent surface. We recognize five kinds:
 *
 *   skill  — a skill pack (SKILL.md)
 *   tool   — a code tool / extension (package.json, pyproject.toml, …)
 *   mcp    — an MCP server: a bundled implementation (server.json) or a reference
 *            in settings/.mcp.json (scanned via its launch command)
 *   hooks  — inline shell in a settings file that auto-runs on agent events
 *   prompt — instruction surface (CLAUDE.md, slash-command / subagent .md files)
 *            that can steer the agent (the AITM / steerability surface)
 *
 * Each target's text is scanned for capability atoms via scan-core (content
 * signatures + callee classification against the vendored taxonomy packs). Hooks
 * and settings-referenced MCP servers are scanned from their command strings.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { loadScanner } from "./scanner/index.js";
import { rulesDataRoot } from "./rules.js";
import { scanDimensionPatterns, type DimHint } from "./dimensions.js";

// Structural markers: their presence makes a directory one target and stops the
// walk from recursing past it (one skill pack = one target, not one per file).
const SKILL_MARKERS = new Set(["SKILL.md"]);
const MCP_MARKERS = new Set(["server.json"]);
const TOOL_MARKERS = new Set(["package.json", "pyproject.toml", "setup.py", "requirements.txt"]);

// Config files parsed in place (not stop markers): hooks + MCP-server references.
const CONFIG_FILES = new Set([
  "settings.json", "settings.local.json", ".mcp.json", "mcp.json",
  "opencode.json", "opencode.jsonc",
]);
// Loose instruction files → one prompt target each.
const PROMPT_FILES = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".cursorrules", "AGENT.md"]);
// Directories that are collections of prompt/command/subagent instructions.
const PROMPT_DIRS = new Set(["commands", "agents", "prompts", "rules", "personas"]);
// Dot-dirs that hold agent config and must be descended into even though hidden.
const AGENT_DOTDIRS = new Set([
  ".claude", ".opencode", ".cursor", ".codex", ".gemini", ".aider", ".continue", ".config",
]);

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".idea", ".mypy_cache", ".pytest_cache", ".tox", "site-packages",
]);
const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "tsx",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".php": "php", ".java": "java", ".ps1": "powershell",
};
const TEXT_EXTS = new Set([
  ...Object.keys(LANG_BY_EXT), ".md", ".json", ".txt", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".env", ".html",
]);
const PROMPT_EXTS = new Set([".md", ".txt", ".mdx"]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_TARGETS = 800;

export type TargetKind = "skill" | "mcp" | "tool" | "hooks" | "prompt";

/** A discovered surface element. */
export interface Target {
  /** Display path relative to root ("." for root, "settings.json›hooks" for synthetic). */
  path: string;
  kind: TargetKind;
  label: string;
  /** Absolute directory to walk (dir-backed targets). */
  dir?: string;
  /** Absolute file paths to scan (file-backed targets). */
  files?: string[];
  /** Inline text to scan (hooks / MCP launch commands). */
  synthetic?: Array<{ text: string; lang: string; source: string }>;
}

export interface TargetScan {
  target: string;
  kind: TargetKind;
  atoms: Record<string, number>;
  fileCount: number;
  evidence: Array<{ atom: string; path: string; line: number; evidence: string }>;
  /** Instruction-pattern dimension hints (the semantic-heavy dimensions). */
  dimHints: DimHint[];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function structuralMarker(names: Set<string>): (dir: string) => string | null {
  return (dir) => {
    for (const n of safeReaddir(dir)) if (names.has(n)) return n;
    return null;
  };
}
const hasSkill = structuralMarker(SKILL_MARKERS);
const hasMcp = structuralMarker(MCP_MARKERS);
const hasTool = structuralMarker(TOOL_MARKERS);

function hasSourceFile(dir: string): boolean {
  let found = false;
  const walk = (d: string): void => {
    if (found) return;
    for (const name of safeReaddir(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      if (isDir(p)) walk(p);
      else if (LANG_BY_EXT[extname(name).toLowerCase()] || PROMPT_EXTS.has(extname(name).toLowerCase())) {
        found = true;
        return;
      }
    }
  };
  walk(dir);
  return found;
}

// ── config parsing: hooks + MCP-server references ────────────────────────────

function tryJson(path: string): unknown {
  try {
    const raw = readFileSync(path, "utf8");
    // strip // and /* */ comments so .jsonc parses (opencode allows them)
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/** Deep-collect hook command strings under a `hooks` subtree. */
function collectHookCommands(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectHookCommands(x, out);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.command === "string") out.push(o.command);
    for (const v of Object.values(o)) collectHookCommands(v, out);
  } else if (typeof node === "string") {
    out.push(node);
  }
}

/** From a parsed config, extract a hooks synthetic target (if any hooks exist). */
function hooksTarget(cfg: unknown, rel: string): Target | null {
  if (!cfg || typeof cfg !== "object") return null;
  const hooks = (cfg as Record<string, unknown>).hooks;
  if (!hooks) return null;
  const cmds: string[] = [];
  collectHookCommands(hooks, cmds);
  const commands = [...new Set(cmds.map((c) => c.trim()).filter(Boolean))];
  if (commands.length === 0) return null;
  return {
    path: `${rel}›hooks`,
    kind: "hooks",
    label: `${rel} (hooks ×${commands.length})`,
    synthetic: commands.map((c, i) => ({ text: c, lang: "shell", source: `hook#${i + 1}` })),
  };
}

/** From a parsed config, extract MCP-server references (settings.mcpServers / .mcp.json). */
function mcpRefTargets(cfg: unknown, rel: string): Target[] {
  if (!cfg || typeof cfg !== "object") return [];
  const servers = (cfg as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const out: Target[] = [];
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (!def || typeof def !== "object") continue;
    const d = def as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof d.command === "string") parts.push(d.command);
    if (Array.isArray(d.args)) parts.push(...d.args.filter((a): a is string => typeof a === "string"));
    if (typeof d.url === "string") parts.push(d.url); // remote/SSE server endpoint
    const line = parts.join(" ").trim();
    if (!line) continue;
    out.push({
      path: `${rel}›mcp:${name}`,
      kind: "mcp",
      label: `${name} (mcp ref)`,
      synthetic: [{ text: line, lang: "shell", source: `mcpServers.${name}` }],
    });
  }
  return out;
}

// ── discovery ────────────────────────────────────────────────────────────────

/**
 * Discover every agent-surface target under `root`. Structural markers claim a
 * directory (and stop recursion there); config files and prompt files/dirs are
 * additive and discovered wherever they appear.
 */
export function discover(root: string): Target[] {
  const targets: Target[] = [];
  const push = (t: Target): void => {
    if (targets.length < MAX_TARGETS) targets.push(t);
  };

  const inspectConfigs = (dir: string, relDir: string): void => {
    for (const name of safeReaddir(dir)) {
      if (!CONFIG_FILES.has(name)) continue;
      const cfg = tryJson(join(dir, name));
      const rel = relDir === "." ? name : join(relDir, name);
      const h = hooksTarget(cfg, rel);
      if (h) push(h);
      for (const m of mcpRefTargets(cfg, rel)) push(m);
    }
  };

  const inspectPrompts = (dir: string, relDir: string): void => {
    for (const name of safeReaddir(dir)) {
      const abs = join(dir, name);
      if (PROMPT_FILES.has(name) && !isDir(abs)) {
        push({
          path: relDir === "." ? name : join(relDir, name),
          kind: "prompt",
          label: relDir === "." ? name : join(relDir, name),
          files: [abs],
        });
      } else if (PROMPT_DIRS.has(name) && isDir(abs)) {
        const files = collectPromptFiles(abs);
        if (files.length) {
          const rel = relDir === "." ? name : join(relDir, name);
          push({ path: rel, kind: "prompt", label: `${rel} (×${files.length})`, files });
        }
      }
    }
  };

  const walk = (dir: string, depth: number): void => {
    if (targets.length >= MAX_TARGETS) return;

    // Additive surfaces present in this directory.
    inspectConfigs(dir, relative(root, dir) || ".");
    inspectPrompts(dir, relative(root, dir) || ".");

    // Structural marker → claim this dir as one target, then descend only into
    // agent-config dot-dirs (a code tool can still ship a `.claude/` surface).
    const skill = hasSkill(dir);
    const marker = skill ? "skill" : hasMcp(dir) ? "mcp" : hasTool(dir) ? "tool" : null;
    if (marker) {
      const rel = relative(root, dir) || ".";
      push({ path: rel, kind: marker as TargetKind, label: rel, dir });
      for (const name of safeReaddir(dir)) {
        if (AGENT_DOTDIRS.has(name) && isDir(join(dir, name))) walk(join(dir, name), depth + 1);
      }
      return;
    }

    for (const name of safeReaddir(dir)) {
      if (SKIP_DIRS.has(name) || PROMPT_DIRS.has(name)) continue;
      if (name.startsWith(".") && !AGENT_DOTDIRS.has(name)) continue;
      const p = join(dir, name);
      if (isDir(p)) walk(p, depth + 1);
    }
  };
  walk(root, 0);

  // Fallback: no structural targets found (e.g. a folder of bare tool dirs, or a
  // lone tool). Treat each immediate child dir that holds source as a target.
  if (targets.every((t) => t.kind === "hooks" || t.kind === "prompt" || t.kind === "mcp")) {
    for (const name of safeReaddir(root)) {
      if (SKIP_DIRS.has(name) || (name.startsWith(".") && !AGENT_DOTDIRS.has(name))) continue;
      const p = join(root, name);
      if (isDir(p) && hasSourceFile(p) && !targets.some((t) => t.path === name)) {
        push({ path: name, kind: "tool", label: name, dir: p });
      }
    }
    if (!targets.some((t) => t.dir) && hasSourceFile(root)) {
      push({ path: ".", kind: "tool", label: ".", dir: root });
    }
  }

  return targets;
}

function collectPromptFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of safeReaddir(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      if (isDir(p)) walk(p);
      else if (PROMPT_EXTS.has(extname(name).toLowerCase())) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Back-compat: structural directory targets as relative paths. */
export function sweep(root: string): string[] {
  return discover(root)
    .filter((t) => t.dir)
    .map((t) => t.path);
}

const scanner = loadScanner(rulesDataRoot());

function record(
  atoms: Record<string, number>,
  evidence: TargetScan["evidence"],
  dimHints: DimHint[],
  text: string,
  lang: string,
  path: string,
): void {
  for (const o of scanner.scanText(text, lang)) {
    atoms[o.atom] = (atoms[o.atom] ?? 0) + 1;
    if (evidence.length < 200) {
      evidence.push({ atom: o.atom, path, line: o.line, evidence: o.evidence });
    }
  }
  // Instruction-pattern hints run on ALL text (incl. markdown) — that is the whole
  // point: catch capability the skill *describes* but doesn't express as code.
  if (dimHints.length < 400) dimHints.push(...scanDimensionPatterns(text, path));
}

/** Scan one target → aggregated atoms + evidence + dimension hints. */
export function scanTarget(root: string, target: Target): TargetScan {
  const atoms: Record<string, number> = {};
  const evidence: TargetScan["evidence"] = [];
  const dimHints: DimHint[] = [];
  let fileCount = 0;

  if (target.synthetic) {
    for (const s of target.synthetic) {
      fileCount++;
      record(atoms, evidence, dimHints, s.text, s.lang, `${target.path} (${s.source})`);
    }
  }

  const scanFile = (abs: string): void => {
    const ext = extname(abs).toLowerCase();
    if (!TEXT_EXTS.has(ext)) return;
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.size > MAX_FILE_BYTES) return;
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    fileCount++;
    record(atoms, evidence, dimHints, text, LANG_BY_EXT[ext] ?? "*", relative(root, abs));
  };

  if (target.files) for (const f of target.files) scanFile(f);

  if (target.dir) {
    const walk = (dir: string): void => {
      for (const name of safeReaddir(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        if (isDir(p)) walk(p);
        else scanFile(p);
      }
    };
    walk(target.dir);
  }

  return { target: target.path, kind: target.kind, atoms, fileCount, evidence, dimHints };
}
