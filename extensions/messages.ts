import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { ProgressEntry, WorkflowMessageDetails, WorkflowUIContext } from "./types.ts";

export const WORKFLOW_PROGRESS_MESSAGE_TYPE = "pi-workflows-progress";
export const WORKFLOW_RESULT_MESSAGE_TYPE = "pi-workflows-result";

type WorkflowOutboundMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

export function logWorkflowDiagnostic(message: string, error?: unknown): void {
  if (error === undefined) console.error(message);
  else console.error(message, error);
}

export function supportsWorkflowWidgetSurface(ctx: WorkflowUIContext | undefined): boolean {
  return Boolean(ctx?.hasUI && typeof ctx.ui?.setWidget === "function");
}

export function sendWorkflowMessage(pi: ExtensionAPI, _ctx: unknown, message: WorkflowOutboundMessage): void {
  pi.sendMessage(message);
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatProgressStats(entry: ProgressEntry): string {
  return [
    entry.toolCount !== undefined ? `${entry.toolCount} tools` : undefined,
    entry.tokens !== undefined && entry.tokens > 0 ? `${Math.round(entry.tokens / 1000)}k tok` : undefined,
    formatDuration(entry.durationMs) || undefined,
  ].filter(Boolean).join(", ");
}

function maybeClip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function formatWorkflowToolCall(tool: string | undefined, args: string | undefined): string | undefined {
  if (!tool) return undefined;
  const safeArgs = args ?? "";
  switch (tool) {
    case "bash": return `$ ${maybeClip(safeArgs.replace(/[\n\t]/g, " ").trim(), 100)}`;
    case "read": return `[read: ${safeArgs}]`;
    case "write": return `[write: ${safeArgs}]`;
    case "edit": return `[edit: ${safeArgs}]`;
    case "grep": return `[grep: ${safeArgs}]`;
    case "find": return `[find: ${safeArgs}]`;
    case "ls": return `[ls: ${safeArgs || "."}]`;
    default: return `[${tool}${safeArgs ? `: ${maybeClip(safeArgs, 80)}` : ""}]`;
  }
}

function addText(target: Box | Container, text: string, theme: Theme, color?: string): void {
  target.addChild(new Text(color ? theme.fg(color as never, text) : text, 0, 0));
}

function buildWorkflowProgressWidget(workflowName: string, details: WorkflowMessageDetails, theme: Theme): Component {
  const container = new Container();
  container.addChild(new Spacer(1));
  const status = details.status ?? (details.isError ? "failed" : "running");
  const progress = details.progress ?? details.result?.details?.progress ?? [];
  const bg = status === "failed" ? "toolErrorBg" : status === "completed" ? "toolSuccessBg" : "toolPendingBg";
  const box = new Box(1, 1, (text: string) => theme.bg(bg as never, text));
  container.addChild(box);

  const count = progress.reduce((sum, entry) => sum + (entry.toolCount ?? 0), 0);
  const currentTool = progress.find((entry) => entry.currentTool)?.currentTool;
  const iconColor = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
  const icon = status === "completed" ? "ok" : status === "failed" ? "fail" : "...";
  const stats = [status, count ? `${count} tools` : undefined, currentTool].filter(Boolean).join(" · ");
  addText(box, `${theme.fg(iconColor as never, icon)} ${theme.fg("toolTitle" as never, theme.bold(`workflow /${workflowName}`))} | ${stats}`, theme);
  box.addChild(new Spacer(1));

  if (progress.length === 0) {
    addText(box, "starting subagents...", theme, "dim");
    return container;
  }

  for (const entry of progress.slice(0, 4)) {
    const statsText = formatProgressStats(entry);
    const statusText = entry.status ?? "running";
    addText(
      box,
      `${theme.fg("warning" as never, "...")} ${theme.fg("toolTitle" as never, theme.bold(entry.agent ?? "agent"))}: ${statusText}${statsText ? ` (${statsText})` : ""}`,
      theme,
    );
    const active = formatWorkflowToolCall(entry.currentTool, entry.currentToolArgs);
    if (active) addText(box, `    > ${active}`, theme, "warning");
    for (const recentTool of (entry.recentTools ?? []).slice(-2)) {
      const rendered = formatWorkflowToolCall(recentTool.tool, recentTool.args);
      if (rendered) addText(box, `    ${rendered}`, theme, "dim");
    }
    for (const output of (entry.recentOutput ?? []).slice(-2).filter((line) => line.trim())) {
      addText(box, `    ${output.trim()}`, theme, "dim");
    }
    if (entry.error) addText(box, `    error: ${entry.error}`, theme, "error");
  }
  if (progress.length > 4) addText(box, `... ${progress.length - 4} more agents — Ctrl+O for details`, theme, "warning");
  return container;
}

export function setWorkflowProgressWidget(ctx: WorkflowUIContext | undefined, workflowName: string, details: WorkflowMessageDetails): boolean {
  if (!supportsWorkflowWidgetSurface(ctx)) return false;
  try {
    ctx?.ui?.setWidget?.("pi-workflows", (_tui: unknown, theme: Theme) => buildWorkflowProgressWidget(workflowName, details, theme));
    return true;
  } catch (error) {
    logWorkflowDiagnostic(`Workflow /${workflowName} failed to update progress widget.`, error);
    return false;
  }
}

export function clearWorkflowProgressWidget(ctx: WorkflowUIContext | undefined): void {
  if (!supportsWorkflowWidgetSurface(ctx)) return;
  try {
    ctx?.ui?.setWidget?.("pi-workflows", undefined);
  } catch (error) {
    logWorkflowDiagnostic("pi-workflows failed to clear progress widget.", error);
  }
}

export function sendWorkflowProgressMessage(
  pi: ExtensionAPI,
  ctx: WorkflowUIContext | undefined,
  message: WorkflowOutboundMessage,
): void {
  const details = (message.details && typeof message.details === "object" ? message.details : {}) as WorkflowMessageDetails;
  if (details.workflow && supportsWorkflowWidgetSurface(ctx) && setWorkflowProgressWidget(ctx, details.workflow, details)) return;
  try {
    sendWorkflowMessage(pi, ctx, { ...message, display: true });
  } catch (error) {
    logWorkflowDiagnostic(`Workflow /${details.workflow ?? "workflow"} failed to send progress message.`, error);
  }
}
