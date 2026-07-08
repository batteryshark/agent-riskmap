/**
 * agent-riskmap triage loop for Pi (pi-coding-agent).
 *
 * Point it at an agent surface; a deterministic scan seeds the ledger with every
 * reachable capability combination, then the model triages each finding — reads
 * the cited evidence, follows the flow, and confirms / dismisses / gates it. The
 * ledger's resume() owns termination; the model never self-terminates and never
 * invents findings (detection is deterministic and already complete).
 *
 * Install:
 *   ~/.pi/agent/extensions/agent-riskmap/index.ts   ← this file
 *   ~/.pi/agent/extensions/agent-riskmap/package.json:
 *       { "dependencies": { "@stonefish-labs/agent-riskmap": "^0.0.1" } }
 *   npm install in that directory; pi discovers it on next start.
 *
 * Usage:
 *   /agent-riskmap scan <dir>     scan a surface, seed the ledger, start triage
 *   /agent-riskmap stop           halt the loop
 *   /agent-riskmap status         show the ledger
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { seedTriageLedger, buildTriageTurn } from "@stonefish-labs/agent-riskmap/triage";
import {
  loadState,
  startItem,
  resolveItem,
  acceptItem,
  blockItem,
  noteItem,
  setLabelItem,
  getNextActionable,
  formatShow,
  resume as ledgerResume,
  TERMINAL_STATES,
  EXIT_COMPLETE,
  EXIT_MAX_ITERATIONS,
  EXIT_DEADLOCKED,
} from "@stonefish-labs/agent-riskmap/ledger";

interface LoopState {
  active: boolean;
  cwd: string;
  iteration: number;
}
let loop: LoopState | null = null;

function coverage(cwd: string): { total: number; terminal: number } {
  const s = loadState(cwd);
  const total = s?.items.length ?? 0;
  const terminal = s?.items.filter((i) => TERMINAL_STATES.includes(i.status)).length ?? 0;
  return { total, terminal };
}

/** Run the scan, seed the ledger, and arm the loop. Returns a human summary. */
function scanAndSeed(dir: string, cwd: string): string {
  const { report, itemCount } = seedTriageLedger({ targetDir: dir, cwd, force: true });
  loop = { active: itemCount > 0, cwd, iteration: 1 };
  const s = report.surface;
  const surface = (Object.keys(s) as (keyof typeof s)[])
    .filter((k) => s[k] > 0)
    .map((k) => `${s[k]} ${k}`)
    .join(" · ");
  if (itemCount === 0) {
    return `agent-riskmap: scanned ${dir}\nsurface: ${surface}\n${report.headline}\nNo abuse-path findings to triage.`;
  }
  return (
    `agent-riskmap: scanned ${dir}\n` +
    `surface: ${surface}\n` +
    `posture: ${report.posture.tier} — ${report.posture.headline}\n` +
    `${report.headline}\n` +
    `Seeded ${itemCount} finding(s) into the ledger for triage.`
  );
}

export default function agentRiskmapExtension(pi: ExtensionAPI) {
  pi.registerCommand("agent-riskmap", {
    description: "Scan an agent surface and triage its hazardous capability combinations",
    handler: async (args: string, ctx: ExtensionContext) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "scan") {
        const dir = parts.slice(1).join(" ").trim();
        if (!dir) {
          ctx.ui.notify('Usage: /agent-riskmap scan <dir>', "error");
          return;
        }
        try {
          const summary = scanAndSeed(dir, ctx.cwd);
          ctx.ui.notify(summary, "info");
          if (loop?.active) {
            ctx.ui.setStatus("agent-riskmap", `🗺️ triage 0/${coverage(ctx.cwd).total}`);
            pi.sendMessage(
              { customType: "agent-riskmap", content: `[agent-riskmap] ${summary}`, display: true },
              { triggerTurn: true },
            );
          }
        } catch (e) {
          ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
        }
        return;
      }

      if (sub === "stop") {
        if (loop) {
          loop.active = false;
          ctx.ui.setStatus("agent-riskmap", undefined);
          ctx.ui.notify("agent-riskmap triage stopped.", "info");
          loop = null;
        }
        return;
      }

      if (sub === "status") {
        const s = loadState(ctx.cwd);
        ctx.ui.notify(s ? formatShow(s) : "No ledger found. Run /agent-riskmap scan <dir>.", "info");
        return;
      }

      ctx.ui.notify("Usage: /agent-riskmap scan <dir> | stop | status", "info");
    },
  });

  // Let the model kick off a scan itself.
  pi.registerTool({
    name: "agent_riskmap_scan",
    label: "agent-riskmap scan",
    description:
      "Scan an agent surface (a directory of skills / MCP servers / hooks / prompts / extensions) for " +
      "hazardous capability combinations (EXFIL / RCE / DROP) and seed the triage ledger. Returns a " +
      "summary; then triage each seeded finding with the `ledger` tool.",
    parameters: Type.Object({
      dir: Type.String({ description: "Path to the agent surface to scan" }),
    }),
    async execute(_id, params: any, _signal, _onUpdate, ctx) {
      try {
        const summary = scanAndSeed(params.dir, ctx.cwd);
        return { content: [{ type: "text", text: summary }], details: {} };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
      }
    },
  });

  // Triage mutation tool. Detection is deterministic — there is deliberately no
  // "add": the model adjudicates seeded findings, it does not create new ones.
  pi.registerTool({
    name: "ledger",
    label: "Ledger",
    description:
      "Adjudicate the agent-riskmap triage ledger. Actions: show, next, pending, start, resolve, accept, block, label, note. " +
      "resolve = real/plausible abuse path (+recommended gate); accept = false positive (+rationale); block = needs a human. " +
      "Set state_label confirmed | gated | dismissed | needs-human.",
    parameters: Type.Object({
      action: Type.String({ description: "show | next | pending | start | resolve | accept | block | label | note" }),
      id: Type.Optional(Type.String({ description: "Finding ID" })),
      result: Type.Optional(Type.String({ description: "Verdict + recommended gate (for resolve)" })),
      rationale: Type.Optional(Type.String({ description: "Why it's a false positive (for accept)" })),
      reason: Type.Optional(Type.String({ description: "What a human must decide (for block)" })),
      evidence: Type.Optional(Type.String({ description: "Supporting citation (for resolve)" })),
      label: Type.Optional(Type.String({ description: "state_label: evaluating | confirmed | gated | dismissed | needs-human" })),
      text: Type.Optional(Type.String({ description: "Note text (for note)" })),
    }),
    async execute(_id, params: any, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      try {
        switch (params.action) {
          case "show": {
            const s = loadState(cwd);
            return { content: [{ type: "text", text: s ? formatShow(s) : "No ledger found." }], details: {} };
          }
          case "next": {
            const s = loadState(cwd);
            return { content: [{ type: "text", text: s ? JSON.stringify(getNextActionable(s), null, 2) : "No ledger found." }], details: {} };
          }
          case "pending": {
            const s = loadState(cwd);
            const pending = s ? s.items.filter((i) => !TERMINAL_STATES.includes(i.status)) : [];
            return { content: [{ type: "text", text: JSON.stringify(pending, null, 2) }], details: {} };
          }
          case "start":
            return { content: [{ type: "text", text: JSON.stringify(startItem(params.id, cwd), null, 2) }], details: {} };
          case "resolve":
            return { content: [{ type: "text", text: JSON.stringify(resolveItem(params.id, params.result, params.evidence, params.label ?? "confirmed", cwd), null, 2) }], details: {} };
          case "accept":
            return { content: [{ type: "text", text: JSON.stringify(acceptItem(params.id, params.rationale, params.label ?? "dismissed", cwd), null, 2) }], details: {} };
          case "block":
            return { content: [{ type: "text", text: JSON.stringify(blockItem(params.id, params.reason, params.label ?? "needs-human", cwd), null, 2) }], details: {} };
          case "label":
            return { content: [{ type: "text", text: JSON.stringify(setLabelItem(params.id, params.label ?? null, cwd), null, 2) }], details: {} };
          case "note":
            return { content: [{ type: "text", text: JSON.stringify(noteItem(params.id, params.text, cwd), null, 2) }], details: {} };
          default:
            return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
        }
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], details: {} };
      }
    },
  });

  pi.on("before_agent_start", async (event) => {
    if (!loop?.active) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + buildTriageTurn(loadState(loop.cwd)) };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!loop?.active) return;
    const result = ledgerResume(3, loop.cwd);
    const { total, terminal } = coverage(loop.cwd);

    if (result.exitCode === EXIT_COMPLETE) {
      loop.active = false;
      ctx.ui.setStatus("agent-riskmap", undefined);
      ctx.ui.notify(`✓ Triage complete: ${terminal}/${total} findings adjudicated.`, "info");
      loop = null;
      return;
    }
    if (result.exitCode === EXIT_MAX_ITERATIONS || result.exitCode === EXIT_DEADLOCKED) {
      loop.active = false;
      ctx.ui.setStatus("agent-riskmap", undefined);
      ctx.ui.notify(
        result.exitCode === EXIT_MAX_ITERATIONS ? "Max iterations reached; stopping." : "Deadlocked; check the ledger.",
        "warning",
      );
      loop = null;
      return;
    }

    loop.iteration++;
    ctx.ui.setStatus("agent-riskmap", `🗺️ triage ${terminal}/${total}`);
    pi.sendMessage(
      { customType: "agent-riskmap", content: `[agent-riskmap] ${terminal}/${total} adjudicated — continue triage.`, display: true },
      { triggerTurn: true },
    );
  });

  pi.on("session_start", async (_event, ctx) => {
    const s = loadState(ctx.cwd);
    if (s) {
      const terminal = s.items.filter((i) => TERMINAL_STATES.includes(i.status)).length;
      ctx.ui.setStatus("agent-riskmap", `🗺️ ${terminal}/${s.items.length} adjudicated`);
    }
  });
}
