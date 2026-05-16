import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sendWorkflowMessage } from "./messages.ts";
import { registerWorkflowRenderers } from "./rendering.ts";
import { splitArgs } from "./templates.ts";
import { buildSubagentParams, listWorkflowText, runWorkflow, workflowLoadSummary } from "./workflow-runner.ts";
import { loadWorkflows } from "./workflow-schema.ts";
import type { Workflow, WorkflowLoadWarning } from "./types.ts";

export { requestSubagentRun } from "./subagent-bridge.ts";
export { splitArgs } from "./templates.ts";
export { buildSubagentParams, runWorkflow, workflowContainsNestedWorkflow } from "./workflow-runner.ts";
export { loadWorkflows, parseWorkflowFile, stripJsonComments } from "./workflow-schema.ts";
export type { Workflow } from "./types.ts";

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // UI notifications are best-effort.
  }
}

function projectWorkflowDir(cwd: string): string {
  return resolve(join(cwd, ".pi", "workflows"));
}

function projectDiscoveryWarning(cwd: string, warnings: WorkflowLoadWarning[]): WorkflowLoadWarning | undefined {
  const projectDir = projectWorkflowDir(cwd);
  return warnings.find((warning) => resolve(warning.path) === projectDir && /project workflow directory could not be read/.test(warning.error));
}

function workflowIsProjectLocal(workflow: Workflow, cwd: string): boolean {
  const rel = relative(projectWorkflowDir(cwd), resolve(workflow.sourcePath));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function refuseProjectDiscoveryFallback(pi: ExtensionAPI, ctx: ExtensionCommandContext, workflow: Workflow, warnings: WorkflowLoadWarning[]): boolean {
  const warning = projectDiscoveryWarning(ctx.cwd, warnings);
  if (!warning || workflowIsProjectLocal(workflow, ctx.cwd)) return false;
  const message = `Project workflow directory could not be read, so /${workflow.name} was not run to avoid falling back to a user workflow by mistake.`;
  safeNotify(ctx, message, "error");
  sendWorkflowMessage(pi, ctx, {
    customType: "pi-workflows-list",
    content: `${message}\n\n${warning.path}: ${warning.error}`,
    display: true,
    details: { warnings },
  });
  return true;
}

function registerWorkflowCommand(pi: ExtensionAPI, workflow: Workflow): void {
  const workflowName = workflow.name;
  pi.registerCommand(workflowName, {
    description: workflow.description ? `Workflow: ${workflow.description}` : `Workflow: ${workflowName}`,
    handler: async (args, ctx) => {
      const warnings: WorkflowLoadWarning[] = [];
      const workflows = loadWorkflows(ctx.cwd, warnings);
      const selected = workflows.find((candidate) => candidate.name === workflowName);
      if (!selected) {
        safeNotify(ctx, `Workflow not found: ${workflowName}. Try /workflow --list or /reload.`, "error");
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: `Workflow not found: ${workflowName}\n\n${listWorkflowText(workflows, warnings)}`,
          display: true,
          details: { workflows, warnings },
        });
        return;
      }
      if (refuseProjectDiscoveryFallback(pi, ctx, selected, warnings)) return;
      await runWorkflow(pi, ctx, selected, args);
    },
  });
}

export default function registerPiWorkflows(pi: ExtensionAPI): void {
  let activeCwd = resolve(process.cwd());
  const registeredWorkflowCommands = new Set<string>(["workflow"]);

  const discoverWorkflows = (cwd: string): { workflows: Workflow[]; warnings: WorkflowLoadWarning[] } => {
    const warnings: WorkflowLoadWarning[] = [];
    const workflows = loadWorkflows(cwd, warnings);
    return { workflows, warnings };
  };

  const registerUserWorkflowCommands = (cwd: string): void => {
    const workflows = loadWorkflows(cwd, [], true, ["user"]);
    for (const workflow of workflows) {
      if (registeredWorkflowCommands.has(workflow.name)) continue;
      registerWorkflowCommand(pi, workflow);
      registeredWorkflowCommands.add(workflow.name);
    }
  };

  registerWorkflowRenderers(pi);
  registerUserWorkflowCommands(activeCwd);

  pi.registerCommand("workflow", {
    description: "Run a named pi-workflows workflow: /workflow <name> [args]",
    getArgumentCompletions: (prefix: string) => {
      const tokens = splitArgs(prefix);
      if (tokens.length > 1 || (tokens.length === 1 && prefix.endsWith(" "))) return null;
      const needle = tokens[0] ?? "";
      return loadWorkflows(activeCwd, [], false)
        .filter((workflow) => workflow.name.startsWith(needle))
        .map((workflow) => ({ value: workflow.name, label: workflow.name, description: workflow.description }));
    },
    handler: async (args, ctx) => {
      activeCwd = resolve(ctx.cwd);
      const trimmed = args.trim();
      registerUserWorkflowCommands(activeCwd);
      const { workflows, warnings } = discoverWorkflows(activeCwd);
      if (!trimmed || trimmed === "--list" || trimmed === "list") {
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: listWorkflowText(workflows, warnings),
          display: true,
          details: { workflows, warnings },
        });
        return;
      }

      const firstSpace = trimmed.search(/\s/);
      const name = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
      const workflow = workflows.find((candidate) => candidate.name === name);
      if (!workflow) {
        safeNotify(ctx, `Workflow not found: ${name}`, "error");
        sendWorkflowMessage(pi, ctx, {
          customType: "pi-workflows-list",
          content: `Workflow not found: ${name}\n\n${listWorkflowText(workflows, warnings)}`,
          display: true,
          details: { workflows, warnings },
        });
        return;
      }
      if (refuseProjectDiscoveryFallback(pi, ctx, workflow, warnings)) return;
      await runWorkflow(pi, ctx, workflow, rest);
    },
  });

  pi.on?.("session_start", (_event, ctx) => {
    activeCwd = resolve(ctx.cwd);
    registerUserWorkflowCommands(activeCwd);
    const { workflows, warnings } = discoverWorkflows(activeCwd);
    if (ctx.hasUI) safeNotify(ctx, workflowLoadSummary(workflows, warnings), warnings.length ? "warning" : "info");
  });
}
