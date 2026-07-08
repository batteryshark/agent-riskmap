/**
 * ledger.ts — Generic ledger state machine for Ralph-style loops. (TypeScript)
 *
 * The ledger is the single source of truth for what work exists and what's done.
 * The loop driver calls `resume()` to decide whether to continue. The agent calls
 * `addItem()`/`startItem()`/`resolveItem()` to mutate the ledger.
 *
 * Dual interface:
 *   1. Importable module — plugins import the functions directly (no subprocess)
 *   2. CLI — agent and external scripts call via `npx tsx ledger.ts <command>`
 *
 * State file: ./.ledger/state.json (cwd-relative by design)
 *
 * Exit codes for `resume`:
 *   0   actionable non-terminal items remain → continue
 *   10  all items terminal → complete (coverage achieved)
 *   11  max iterations reached → safety ceiling
 *   12  items remain but none actionable → deadlocked, needs human
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type ItemStatus = "discovered" | "in_progress" | "resolved" | "accepted" | "blocked";

export interface LedgerItem {
  id: string;
  target: string;
  operation: string;
  category: string;
  title: string;
  status: ItemStatus;
  depends_on: string[];
  discovered_at: number;
  resolved_at: number | null;
  attempts: number;
  result: string | null;
  evidence: string | null;
  state_label: string | null;
  notes: Array<{ iteration: number; text: string }>;
}

export interface LedgerState {
  version: number;
  subject: string;
  categories: string[];
  operations: string[];
  created: number;
  max_iterations: number;
  iteration: number;
  items: LedgerItem[];
  last_discovery_iteration: number;
  idle_rounds: number;
  items_at_last_check: number;
  terminal_at_last_check: number;
}

export interface ResumeResult {
  exitCode: number;
  message: string;
  state: LedgerState;
}

// ── Constants ───────────────────────────────────────────────────────────────

export const TERMINAL_STATES: ItemStatus[] = ["resolved", "accepted", "blocked"];
export const EXIT_CONTINUE = 0;
export const EXIT_COMPLETE = 10;
export const EXIT_MAX_ITERATIONS = 11;
export const EXIT_DEADLOCKED = 12;

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_IDLE_ROUNDS = 3;
const LEDGER_DIR = ".ledger";
const STATE_FILE = join(LEDGER_DIR, "state.json");

// ── File I/O ────────────────────────────────────────────────────────────────

export function loadState(cwd: string = process.cwd()): LedgerState | null {
  const p = join(cwd, STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as LedgerState;
  } catch {
    return null;
  }
}

/** Load a ledger state from an explicit file path (vs. cwd-relative `loadState`). */
export function loadStateFile(path: string): LedgerState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LedgerState;
  } catch {
    return null;
  }
}

export function saveState(state: LedgerState, cwd: string = process.cwd()): void {
  const dir = join(cwd, LEDGER_DIR);
  mkdirSync(dir, { recursive: true });
  // Durable write: serialize to a temp file, then atomically rename over the
  // target. A crash mid-write leaves the previous state.json intact rather than a
  // truncated/corrupt file — important for long-running loops.
  const target = join(cwd, STATE_FILE);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);
}

export function clearLedger(cwd: string = process.cwd()): boolean {
  const p = join(cwd, STATE_FILE);
  if (existsSync(p)) {
    unlinkSync(p);
    return true;
  }
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nextId(state: LedgerState): string {
  return `item-${String(state.items.length + 1).padStart(3, "0")}`;
}

export function findItem(state: LedgerState, id: string): LedgerItem | null {
  return state.items.find((i) => i.id === id) ?? null;
}

export function isActionable(state: LedgerState, item: LedgerItem): boolean {
  if (TERMINAL_STATES.includes(item.status)) return false;
  for (const depId of item.depends_on) {
    const dep = findItem(state, depId);
    if (!dep || !TERMINAL_STATES.includes(dep.status)) return false;
  }
  return true;
}

export function getCoverage(state: LedgerState): { total: number; terminal: number } {
  const total = state.items.length;
  const terminal = state.items.filter((i) => TERMINAL_STATES.includes(i.status)).length;
  return { total, terminal };
}

export function getPending(state: LedgerState): LedgerItem[] {
  return state.items.filter((i) => !TERMINAL_STATES.includes(i.status));
}

export function getNextActionable(state: LedgerState): LedgerItem | null {
  const inProgress = state.items.find((i) => i.status === "in_progress");
  if (inProgress) return inProgress;
  return state.items.find((i) => isActionable(state, i)) ?? null;
}

// ── Mutation Functions ──────────────────────────────────────────────────────

export function initLedger(opts: {
  subject: string;
  categories: string[];
  operations?: string[];
  maxIterations?: number;
  force?: boolean;
  cwd?: string;
}): LedgerState {
  const cwd = opts.cwd ?? process.cwd();
  const existing = loadState(cwd);
  if (existing && !opts.force) {
    throw new Error(`Ledger already exists at ${join(cwd, STATE_FILE)}. Use force to overwrite.`);
  }

  const state: LedgerState = {
    version: 1,
    subject: opts.subject,
    categories: opts.categories,
    operations: opts.operations ?? [],
    created: Date.now() / 1000,
    max_iterations: opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    iteration: 0,
    items: [],
    last_discovery_iteration: 0,
    idle_rounds: 0,
    items_at_last_check: 0,
    terminal_at_last_check: 0,
  };
  saveState(state, cwd);
  return state;
}

export function addItem(opts: {
  target: string;
  operation: string;
  category: string;
  title: string;
  evidence?: string;
  dependsOn?: string[];
  stateLabel?: string;
  cwd?: string;
}): LedgerItem {
  const cwd = opts.cwd ?? process.cwd();
  const state = loadState(cwd);
  if (!state) throw new Error("No ledger found. Run init first.");

  const dependsOn = opts.dependsOn ?? [];
  for (const depId of dependsOn) {
    if (!findItem(state, depId)) throw new Error(`Dependency ${depId} not found in ledger.`);
  }

  const item: LedgerItem = {
    id: nextId(state),
    target: opts.target,
    operation: opts.operation,
    category: opts.category,
    title: opts.title,
    status: "discovered",
    depends_on: dependsOn,
    discovered_at: state.iteration,
    resolved_at: null,
    attempts: 0,
    result: null,
    evidence: opts.evidence ?? null,
    state_label: opts.stateLabel ?? null,
    notes: [],
  };

  state.items.push(item);
  state.last_discovery_iteration = state.iteration;
  saveState(state, cwd);
  return item;
}

function loadAndFind(id: string, cwd?: string): { state: LedgerState; item: LedgerItem } {
  const state = loadState(cwd);
  if (!state) throw new Error("No ledger found.");
  const item = findItem(state, id);
  if (!item) throw new Error(`Item ${id} not found.`);
  return { state, item };
}

export function startItem(id: string, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  if (!isActionable(state, item)) {
    const blockedDeps = item.depends_on.filter((d) => {
      const dep = findItem(state, d);
      return !dep || !TERMINAL_STATES.includes(dep.status);
    });
    if (blockedDeps.length > 0) {
      throw new Error(`${id} is not actionable — dependencies not resolved: ${blockedDeps.join(", ")}`);
    }
    throw new Error(`${id} is already terminal (${item.status}).`);
  }
  item.status = "in_progress";
  item.attempts += 1;
  saveState(state, cwd);
  return item;
}

export function resolveItem(id: string, result: string, evidence?: string, stateLabel?: string, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  item.status = "resolved";
  item.resolved_at = state.iteration;
  item.result = result;
  if (evidence) item.evidence = evidence;
  if (stateLabel) item.state_label = stateLabel;
  saveState(state, cwd);
  return item;
}

export function acceptItem(id: string, rationale: string, stateLabel?: string, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  item.status = "accepted";
  item.resolved_at = state.iteration;
  item.result = `ACCEPTED: ${rationale}`;
  if (stateLabel) item.state_label = stateLabel;
  saveState(state, cwd);
  return item;
}

export function blockItem(id: string, reason: string, stateLabel?: string, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  item.status = "blocked";
  item.resolved_at = state.iteration;
  item.result = `BLOCKED: ${reason}`;
  if (stateLabel) item.state_label = stateLabel;
  saveState(state, cwd);
  return item;
}

export function setLabelItem(id: string, label: string | null, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  item.state_label = label;
  saveState(state, cwd);
  return item;
}

export function noteItem(id: string, text: string, cwd?: string): LedgerItem {
  const { state, item } = loadAndFind(id, cwd);
  item.notes.push({ iteration: state.iteration, text });
  saveState(state, cwd);
  return item;
}

// ── Resume (Termination Oracle) ─────────────────────────────────────────────

export function resume(idleRounds: number = DEFAULT_IDLE_ROUNDS, cwd?: string): ResumeResult {
  const state = loadState(cwd);
  if (!state) {
    return { exitCode: EXIT_COMPLETE, message: "No active ledger.", state: null as any };
  }

  state.iteration += 1;

  if (state.iteration > state.max_iterations) {
    const { total, terminal } = getCoverage(state);
    saveState(state, cwd);
    return {
      exitCode: EXIT_MAX_ITERATIONS,
      message: `MAX ITERATIONS: ${terminal}/${total} resolved. Safety ceiling reached.`,
      state,
    };
  }

  const actionable = state.items.filter((i) => isActionable(state, i));
  const nonTerminal = getPending(state);
  const { total, terminal } = getCoverage(state);

  if (nonTerminal.length === 0) {
    saveState(state, cwd);
    return {
      exitCode: EXIT_COMPLETE,
      message: `COMPLETE: ${terminal}/${total} items resolved. Full coverage achieved.`,
      state,
    };
  }

  const madeProgress =
    total !== state.items_at_last_check || terminal !== state.terminal_at_last_check;
  state.idle_rounds = madeProgress ? 0 : state.idle_rounds + 1;
  state.items_at_last_check = total;
  state.terminal_at_last_check = terminal;

  if (actionable.length === 0 || state.idle_rounds >= idleRounds) {
    saveState(state, cwd);
    const reason =
      actionable.length === 0
        ? "no actionable items (dependencies unresolved)"
        : `no progress for ${state.idle_rounds} consecutive rounds`;
    return {
      exitCode: EXIT_DEADLOCKED,
      message: `DEADLOCKED: ${terminal}/${total} resolved, ${nonTerminal.length} pending — ${reason}.`,
      state,
    };
  }

  saveState(state, cwd);
  return {
    exitCode: EXIT_CONTINUE,
    message: `CONTINUE: ${terminal}/${total} resolved. ${actionable.length} actionable, ${nonTerminal.length} pending. Iteration ${state.iteration}.`,
    state,
  };
}

// ── Display ─────────────────────────────────────────────────────────────────

export function formatShow(state: LedgerState): string {
  const { total, terminal } = getCoverage(state);
  const pending = total - terminal;
  const lines: string[] = [];

  lines.push(`Subject: ${state.subject}`);
  lines.push(`Iteration: ${state.iteration}/${state.max_iterations}`);
  lines.push(`Coverage: ${terminal}/${total} resolved (${pending} pending)`);
  lines.push("");

  const byStatus: Record<string, LedgerItem[]> = {};
  for (const item of state.items) {
    (byStatus[item.status] ??= []).push(item);
  }

  const order: ItemStatus[] = ["in_progress", "discovered", "resolved", "accepted", "blocked"];
  const markers: Record<string, string> = {
    in_progress: "►",
    discovered: "○",
    resolved: "✓",
    accepted: "△",
    blocked: "✗",
  };

  for (const status of order) {
    const items = byStatus[status];
    if (!items?.length) continue;
    lines.push(`  ${markers[status]} ${status} (${items.length}):`);
    for (const item of items) {
      let line = `    ${item.id} [${item.operation}] ${item.target}`;
      if (item.state_label) line += `  {${item.state_label}}`;
      if (item.depends_on.length > 0) {
        const unresolved = item.depends_on.filter((d) => {
          const dep = findItem(state, d);
          return dep && !TERMINAL_STATES.includes(dep.status);
        });
        if (unresolved.length > 0) {
          line += `  [waiting on: ${unresolved.join(", ")}]`;
        }
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function cliMain(): void {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cwd = process.cwd();

  const str = (v: string | boolean | undefined): string =>
    typeof v === "string" ? v : "";
  const num = (v: string | boolean | undefined, fallback: number): number =>
    typeof v === "string" ? parseInt(v, 10) || fallback : fallback;

  try {
    switch (command) {
      case "init": {
        const state = initLedger({
          subject: str(args.subject),
          categories: str(args.categories).split(",").map((s) => s.trim()).filter(Boolean),
          operations: str(args.operations)
            ? str(args.operations).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          maxIterations: num(args.max_iterations, DEFAULT_MAX_ITERATIONS),
          force: args.force === true,
          cwd,
        });
        console.log(`Initialized ledger for: ${state.subject}`);
        console.log(`  Categories: ${state.categories.join(", ")}`);
        if (state.operations.length) console.log(`  Operations: ${state.operations.join(", ")}`);
        console.log(`  Max iterations: ${state.max_iterations}`);
        console.log(`  State: ${join(cwd, STATE_FILE)}`);
        break;
      }
      case "add": {
        const item = addItem({
          target: str(args.target),
          operation: str(args.operation),
          category: str(args.category),
          title: str(args.title),
          evidence: args.evidence ? str(args.evidence) : undefined,
          dependsOn: args.depends_on
            ? str(args.depends_on).split(",").map((s) => s.trim()).filter(Boolean)
            : undefined,
          stateLabel: args.state_label ? str(args.state_label) : undefined,
          cwd,
        });
        console.log(JSON.stringify(item, null, 2));
        break;
      }
      case "start":
        console.log(JSON.stringify(startItem(str(args.id), cwd), null, 2));
        break;
      case "resolve":
        console.log(JSON.stringify(resolveItem(str(args.id), str(args.result), args.evidence ? str(args.evidence) : undefined, args.state_label ? str(args.state_label) : undefined, cwd), null, 2));
        break;
      case "accept":
        console.log(JSON.stringify(acceptItem(str(args.id), str(args.rationale), args.state_label ? str(args.state_label) : undefined, cwd), null, 2));
        break;
      case "block":
        console.log(JSON.stringify(blockItem(str(args.id), str(args.reason), args.state_label ? str(args.state_label) : undefined, cwd), null, 2));
        break;
      case "label":
      case "set-label":
        console.log(JSON.stringify(setLabelItem(str(args.id), args.label ? str(args.label) : null, cwd), null, 2));
        break;
      case "note":
        console.log(JSON.stringify(noteItem(str(args.id), str(args.text), cwd), null, 2));
        break;
      case "show": {
        const state = loadState(cwd);
        if (!state) { console.error("No ledger found."); process.exit(1); }
        console.log(formatShow(state));
        break;
      }
      case "next": {
        const state = loadState(cwd);
        if (!state) { console.error("No ledger found."); process.exit(1); }
        console.log(JSON.stringify(getNextActionable(state), null, 2));
        break;
      }
      case "pending": {
        const state = loadState(cwd);
        if (!state) { console.error("No ledger found."); process.exit(1); }
        console.log(JSON.stringify(getPending(state), null, 2));
        break;
      }
      case "resume": {
        const result = resume(num(args.idle_rounds, DEFAULT_IDLE_ROUNDS), cwd);
        console.log(result.message);
        process.exit(result.exitCode);
      }
      case "clear": {
        if (args.yes !== true) { console.error("Pass --yes to confirm."); process.exit(1); }
        clearLedger(cwd);
        console.log("Ledger cleared.");
        break;
      }
      default:
        console.error("Usage: ledger.ts <init|add|start|resolve|accept|block|label|note|show|next|pending|resume|clear> [options]");
        process.exit(1);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

// Run CLI when invoked directly, not when imported
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("ledger.ts") ||
   process.argv[1].endsWith("ledger.js") ||
   process.argv[1].endsWith("ledger.mjs"));

if (isDirectInvocation) {
  cliMain();
}
