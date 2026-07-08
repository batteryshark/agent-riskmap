/**
 * agent-riskmap triage loop for OpenCode.
 *
 * A deterministic scan seeds the ledger with every reachable capability
 * combination on an agent surface; the model then triages each finding (read the
 * cited evidence, follow the flow, confirm / dismiss / gate). The session.idle
 * hook reads the ledger's resume() to decide continuation — the model cannot
 * self-terminate, and it never invents findings (detection is already complete).
 *
 * Install — add to ~/.config/opencode/opencode.json:
 *   { "plugin": ["@stonefish-labs/agent-riskmap/extensions/opencode/index.ts"] }
 * (the package must be installed where opencode can resolve it.)
 *
 * Usage: ask the agent to "scan <dir> with agent-riskmap", or call the
 * `agent_riskmap` tool with action "scan". Triage then runs to completion.
 */

import { tool } from "@opencode-ai/plugin";
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

export default async function AgentRiskmapPlugin(ctx: any) {
  const client = ctx.client;
  const directory = ctx.directory || process.cwd();
  const LOOP_FLAG = join(directory, ".ledger", "loop.active");

  const isActive = () => existsSync(LOOP_FLAG);
  const setActive = (on: boolean) => {
    if (on) {
      mkdirSync(join(directory, ".ledger"), { recursive: true });
      writeFileSync(LOOP_FLAG, "1");
    } else if (existsSync(LOOP_FLAG)) {
      unlinkSync(LOOP_FLAG);
    }
  };

  function scanAndSeed(dir: string): string {
    const { report, itemCount } = seedTriageLedger({ targetDir: dir, cwd: directory, force: true });
    setActive(itemCount > 0);
    const s = report.surface;
    const surface = (Object.keys(s) as (keyof typeof s)[]).filter((k) => s[k] > 0).map((k) => `${s[k]} ${k}`).join(" · ");
    if (itemCount === 0) return `agent-riskmap: scanned ${dir}\nsurface: ${surface}\n${report.headline}\nNo abuse-path findings to triage.`;
    return (
      `agent-riskmap: scanned ${dir}\nsurface: ${surface}\n` +
      `posture: ${report.posture.tier} — ${report.posture.headline}\n${report.headline}\n` +
      `Seeded ${itemCount} finding(s). Triage each with the \`ledger\` tool (start → resolve/accept/block).`
    );
  }

  return {
    config: async (input: any) => {
      input.command = input.command ?? {};
      // opencode commands require a `template` (the prompt the slash command sends).
      input.command["agent-riskmap"] = {
        description: "Scan an agent surface and triage its hazardous capability combinations",
        template:
          'Use the agent_riskmap tool (action "scan", dir "$ARGUMENTS") to scan the agent surface, ' +
          "then triage every seeded finding with the ledger tool " +
          "(next → start → read the cited evidence → resolve/accept/block) " +
          "until the ledger reports all items terminal.",
      };
    },

    tool: {
      agent_riskmap: tool({
        description:
          "Control agent-riskmap. action \"scan\" (with dir): scan an agent surface for hazardous capability " +
          "combinations (EXFIL/RCE/DROP) and seed the triage ledger. \"status\": show the ledger. \"stop\": halt the loop.",
        args: {
          action: tool.schema.string().describe("scan | status | stop"),
          dir: tool.schema.string().optional().describe("Surface to scan (for scan)"),
        },
        async execute({ action, dir }: any) {
          try {
            if (action === "scan") {
              if (!dir) return "Error: dir is required for scan.";
              return scanAndSeed(dir);
            }
            if (action === "status") {
              const s = loadState(directory);
              return s ? formatShow(s) : "No ledger found. Scan a surface first.";
            }
            if (action === "stop") {
              setActive(false);
              return "agent-riskmap triage stopped.";
            }
            return "Usage: action = scan | status | stop";
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),

      // Triage mutation tool. No "add" — the model adjudicates seeded findings,
      // it does not create new ones (detection is deterministic and complete).
      ledger: tool({
        description:
          "Adjudicate the agent-riskmap triage ledger. Actions: show, next, pending, start, resolve, accept, block, label, note. " +
          "resolve = real/plausible abuse path (+recommended gate); accept = false positive (+rationale); block = needs a human. " +
          "Set state_label confirmed | gated | dismissed | needs-human.",
        args: {
          action: tool.schema.string().describe("show | next | pending | start | resolve | accept | block | label | note"),
          id: tool.schema.string().optional().describe("Finding ID"),
          result: tool.schema.string().optional().describe("Verdict + recommended gate (for resolve)"),
          rationale: tool.schema.string().optional().describe("Why it's a false positive (for accept)"),
          reason: tool.schema.string().optional().describe("What a human must decide (for block)"),
          evidence: tool.schema.string().optional().describe("Supporting citation (for resolve)"),
          label: tool.schema.string().optional().describe("state_label: evaluating | confirmed | gated | dismissed | needs-human"),
          text: tool.schema.string().optional().describe("Note text (for note)"),
        },
        async execute(params: any) {
          try {
            switch (params.action) {
              case "show": {
                const s = loadState(directory);
                return s ? formatShow(s) : "No ledger found.";
              }
              case "next": {
                const s = loadState(directory);
                return s ? JSON.stringify(getNextActionable(s), null, 2) : "No ledger found.";
              }
              case "pending": {
                const s = loadState(directory);
                return JSON.stringify(s ? s.items.filter((i) => !TERMINAL_STATES.includes(i.status)) : [], null, 2);
              }
              case "start":
                return JSON.stringify(startItem(params.id, directory), null, 2);
              case "resolve":
                return JSON.stringify(resolveItem(params.id, params.result, params.evidence, params.label ?? "confirmed", directory), null, 2);
              case "accept":
                return JSON.stringify(acceptItem(params.id, params.rationale, params.label ?? "dismissed", directory), null, 2);
              case "block":
                return JSON.stringify(blockItem(params.id, params.reason, params.label ?? "needs-human", directory), null, 2);
              case "label":
                return JSON.stringify(setLabelItem(params.id, params.label ?? null, directory), null, 2);
              case "note":
                return JSON.stringify(noteItem(params.id, params.text, directory), null, 2);
              default:
                return `Unknown action: ${params.action}`;
            }
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        },
      }),
    },

    event: async ({ event }: { event: { type: string; properties?: { sessionID?: string } } }) => {
      if (event.type !== "session.idle") return;
      const sessionId = event.properties?.sessionID;
      if (!sessionId || !isActive()) return;

      const result = ledgerResume(3, directory);
      const s = loadState(directory);
      const total = s?.items.length ?? 0;
      const terminal = s?.items.filter((i) => TERMINAL_STATES.includes(i.status)).length ?? 0;

      if (result.exitCode === EXIT_COMPLETE) {
        setActive(false);
        await client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: `[agent-riskmap] Triage complete: ${terminal}/${total} findings adjudicated.` }] },
        });
        return;
      }
      if (result.exitCode === EXIT_MAX_ITERATIONS || result.exitCode === EXIT_DEADLOCKED) {
        setActive(false);
        const why = result.exitCode === EXIT_MAX_ITERATIONS ? "Max iterations reached" : "Deadlocked";
        await client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: `[agent-riskmap] ${why}. Use the ledger tool (action "show") to inspect.` }] },
        });
        return;
      }

      if (!s) {
        setActive(false);
        return;
      }
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: { parts: [{ type: "text", text: buildTriageTurn(s) }] },
        });
      } catch {
        /* silent */
      }
    },
  };
}
