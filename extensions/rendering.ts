import type { ExtensionAPI, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  WORKFLOW_PROGRESS_MESSAGE_TYPE,
  WORKFLOW_RESULT_MESSAGE_TYPE,
  logWorkflowDiagnostic,
} from "./messages.ts";
import type {
  AgentResultEntry,
  AgentToolResult,
  ProgressEntry,
  RenderMessageLike,
  RenderOptionsLike,
  SubagentParamsLike,
  WorkflowMessageDetails,
} from "./types.ts";

const plainTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function themeOrFallback(theme: Theme | undefined): Theme {
  return theme ?? plainTheme;
}

function markdownThemeFor(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading" as never, text),
    link: (text) => theme.fg("mdLink" as never, text),
    linkUrl: (text) => theme.fg("mdLinkUrl" as never, text),
    code: (text) => theme.fg("mdCode" as never, text),
    codeBlock: (text) => theme.fg("mdCodeBlock" as never, text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder" as never, text),
    quote: (text) => theme.fg("mdQuote" as never, text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder" as never, text),
    hr: (text) => theme.fg("mdHr" as never, text),
    listBullet: (text) => theme.fg("mdListBullet" as never, text),
    bold: (text) => theme.bold(text),
    italic: (text) => "italic" in theme && typeof theme.italic === "function" ? theme.italic(text) : text,
    underline: (text) => "underline" in theme && typeof theme.underline === "function" ? theme.underline(text) : text,
    strikethrough: (text) => "strikethrough" in theme && typeof theme.strikethrough === "function" ? theme.strikethrough(text) : text,
  };
}

function messageDetails(message: RenderMessageLike): WorkflowMessageDetails {
  return (message.details && typeof message.details === "object" ? message.details : {}) as WorkflowMessageDetails;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type?: string; text?: string } => Boolean(part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text ?? "")
    .join("\n");
}

function addText(target: Box | Container, text: string, theme: Theme, color?: string): void {
  target.addChild(new Text(color ? theme.fg(color as never, text) : text, 0, 0));
}

function addMarkdown(target: Box | Container, text: string, theme: Theme): void {
  target.addChild(new Markdown(text, 0, 0, markdownThemeFor(theme)));
}

function addSpacer(target: Box | Container): void {
  target.addChild(new Spacer(1));
}

function summarizeParams(params: SubagentParamsLike | undefined): string {
  if (!params) return "workflow";
  if (params.chain?.length) return `chain · ${params.chain.length} step${params.chain.length === 1 ? "" : "s"}`;
  if (params.tasks?.length) return `parallel · ${params.tasks.length} agent${params.tasks.length === 1 ? "" : "s"}`;
  if (params.agent) return `single · ${params.agent}`;
  return "workflow";
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

function progressStatusIcon(status: string | undefined): string {
  if (status === "completed" || status === "complete") return "✓";
  if (status === "failed" || status === "error") return "✗";
  if (status === "pending") return "◦";
  return "…";
}

function progressStatusColor(status: string | undefined): string {
  if (status === "completed" || status === "complete") return "success";
  if (status === "failed" || status === "error") return "error";
  if (status === "pending") return "dim";
  return "warning";
}

function maybeClip(value: string, max: number, expanded: boolean): string {
  return !expanded && value.length > max ? `${value.slice(0, max)}...` : value;
}

function formatWorkflowToolCall(tool: string | undefined, args: string | undefined, expanded = false): string | undefined {
  if (!tool) return undefined;
  const safeArgs = args ?? "";
  switch (tool) {
    case "bash": return `$ ${maybeClip(safeArgs.replace(/[\n\t]/g, " ").trim(), 100, expanded)}`;
    case "read": return `[read: ${safeArgs}]`;
    case "write": return `[write: ${safeArgs}]`;
    case "edit": return `[edit: ${safeArgs}]`;
    case "grep": return `[grep: ${safeArgs}]`;
    case "find": return `[find: ${safeArgs}]`;
    case "ls": return `[ls: ${safeArgs || "."}]`;
    default: return `[${tool}${safeArgs ? `: ${maybeClip(safeArgs, 80, expanded)}` : ""}]`;
  }
}

function addProgressEntries(box: Box, progress: ProgressEntry[], expanded: boolean, theme: Theme): void {
  if (progress.length === 0) {
    addText(box, "no agent progress yet", theme, "dim");
    return;
  }

  const limit = expanded ? progress.length : Math.min(progress.length, 4);
  for (let index = 0; index < Math.min(progress.length, limit); index += 1) {
    const entry = progress[index]!;
    const stats = formatProgressStats(entry);
    const status = entry.status ?? "running";
    const icon = theme.fg(progressStatusColor(status) as never, progressStatusIcon(status));
    addText(
      box,
      `${icon} ${theme.fg("toolTitle" as never, theme.bold(entry.agent ?? "agent"))}: ${status}${stats ? ` (${stats})` : ""}`,
      theme,
    );
    const active = formatWorkflowToolCall(entry.currentTool, entry.currentToolArgs, expanded);
    if (active) addText(box, `    > ${active}`, theme, "warning");
    const recentTools = expanded ? (entry.recentTools ?? []).slice(-5) : (entry.recentTools ?? []).slice(-2);
    for (const recentTool of recentTools) {
      const rendered = formatWorkflowToolCall(recentTool.tool, recentTool.args, expanded);
      if (rendered) addText(box, `    ${rendered}`, theme, "dim");
    }
    const recent = expanded ? entry.recentOutput ?? [] : entry.recentOutput?.slice(-3) ?? [];
    for (const output of recent.filter((line) => line.trim())) addText(box, `    ${output.trim()}`, theme, "dim");
    if (entry.error) addText(box, `    error: ${entry.error}`, theme, "error");
    if (index < limit - 1 && index < progress.length - 1) addSpacer(box);
  }
  if (!expanded && progress.length > limit) {
    addSpacer(box);
    addText(box, `... ${progress.length - limit} more agent${progress.length - limit === 1 ? "" : "s"} — Ctrl+O for remaining agents`, theme, "warning");
  }
}

function directText(result: AgentToolResult | undefined): string | undefined {
  const text = result?.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function resultEntryFailed(entry: AgentResultEntry): boolean {
  return Boolean(entry.error) || (typeof entry.exitCode === "number" && entry.exitCode !== 0);
}

function resultEntryText(entry: AgentResultEntry): string | undefined {
  return (entry.error || entry.finalOutput)?.trim() || undefined;
}

function addResultEntry(box: Box, entry: AgentResultEntry, index: number, theme: Theme): void {
  const failed = resultEntryFailed(entry);
  const icon = failed ? theme.fg("error" as never, "✗") : theme.fg("success" as never, "✓");
  addText(box, `${icon} ${theme.fg("toolTitle" as never, theme.bold(entry.agent ?? `agent-${index + 1}`))} · ${failed ? "failed" : "completed"}${entry.model ? ` · ${entry.model}` : ""}`, theme);
  if (entry.task) addText(box, `task: ${entry.task}`, theme, "dim");
  if (entry.sessionFile) addText(box, `session: ${entry.sessionFile}`, theme, "dim");
  if (entry.savedOutputPath) addText(box, `saved output: ${entry.savedOutputPath}`, theme, "dim");
  if (entry.artifactPaths?.inputPath) addText(box, `artifact input: ${entry.artifactPaths.inputPath}`, theme, "dim");
  if (entry.artifactPaths?.outputPath) addText(box, `artifact output: ${entry.artifactPaths.outputPath}`, theme, "dim");
  if ((entry.artifactPaths as Record<string, string | undefined> | undefined)?.jsonlPath) addText(box, `artifact jsonl: ${(entry.artifactPaths as Record<string, string | undefined>).jsonlPath}`, theme, "dim");
  if ((entry.artifactPaths as Record<string, string | undefined> | undefined)?.metadataPath) addText(box, `artifact metadata: ${(entry.artifactPaths as Record<string, string | undefined>).metadataPath}`, theme, "dim");
  const text = resultEntryText(entry);
  if (!text) return;
  addSpacer(box);
  addMarkdown(box, text, theme);
}

function progressEntries(details: WorkflowMessageDetails): ProgressEntry[] {
  return details.result?.details?.progress ?? details.progress ?? [];
}

export function renderWorkflowProgressMessage(
  message: RenderMessageLike,
  options: MessageRenderOptions | RenderOptionsLike = { expanded: false },
  rawTheme?: Theme,
): Component {
  const theme = themeOrFallback(rawTheme);
  const details = messageDetails(message);
  const expanded = options.expanded === true;
  const workflow = details.workflow ?? "workflow";
  const status = details.status ?? "running";
  const progress = details.progress ?? [];
  const container = new Container();
  container.addChild(new Spacer(1));
  const bg = status === "failed" ? "toolErrorBg" : status === "completed" ? "toolSuccessBg" : "toolPendingBg";
  const box = new Box(1, 1, (text: string) => theme.bg(bg as never, text));
  container.addChild(box);
  const toolCount = progress.reduce((sum, entry) => sum + (entry.toolCount ?? 0), 0);
  const currentTool = progress.find((entry) => entry.currentTool)?.currentTool;
  const iconColor = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
  const icon = status === "completed" ? "ok" : status === "failed" ? "fail" : "...";
  addText(box, `${theme.fg(iconColor as never, icon)} ${theme.fg("toolTitle" as never, theme.bold(`workflow /${workflow}`))} | ${[status, toolCount ? `${toolCount} tools` : undefined, currentTool].filter(Boolean).join(" · ")}`, theme);
  if (expanded) {
    addSpacer(box);
    if (details.sourcePath) addText(box, `source: ${details.sourcePath}`, theme, "dim");
    if (details.requestId) addText(box, `request: ${details.requestId}`, theme, "dim");
    if (details.params) addText(box, `params: ${summarizeParams(details.params)}`, theme, "dim");
  }
  addSpacer(box);
  addProgressEntries(box, progress, expanded, theme);
  return container;
}

export function renderWorkflowResultMessage(
  message: RenderMessageLike,
  options: MessageRenderOptions | RenderOptionsLike = { expanded: false },
  rawTheme?: Theme,
): Component {
  const theme = themeOrFallback(rawTheme);
  const details = messageDetails(message);
  const workflow = details.workflow ?? "workflow";
  const expanded = options.expanded === true;
  const result = details.result;
  const resultEntries = result?.details?.results ?? [];
  const partialFailures = result?.details?.partialFailures ?? [];
  const content = messageText(message.content) || directText(result) || details.errorText || details.error || "";
  const isError = details.isError === true;
  const statusText = isError && partialFailures.length > 0 && !details.errorText && !details.error ? "completed with partial failures" : isError ? "failed" : "completed";
  const container = new Container();
  container.addChild(new Spacer(1));
  const icon = isError ? theme.fg(partialFailures.length > 0 ? "warning" as never : "error" as never, partialFailures.length > 0 ? "!" : "✗") : theme.fg("success" as never, "✓");
  const agentCount = resultEntries.length > 0 ? `${resultEntries.length} agent${resultEntries.length === 1 ? "" : "s"}` : undefined;
  const detailHint = resultEntries.length > 0 ? ` · Ctrl+O for ${resultEntries.length} agent detail${resultEntries.length === 1 ? "" : "s"}` : "";
  addText(container, `${icon} ${theme.fg("toolTitle" as never, theme.bold(`workflow /${workflow}`))} ${statusText}${agentCount ? ` · ${agentCount}` : ""}${expanded ? "" : detailHint}`, theme);
  addSpacer(container);

  if (expanded) {
    const detailsAny = result?.details as Record<string, unknown> | undefined;
    const artifacts = detailsAny?.artifacts as { dir?: string } | undefined;
    const metaLines = [
      details.sourcePath ? `source: ${details.sourcePath}` : undefined,
      details.requestId ? `request: ${details.requestId}` : undefined,
      details.params ? `params: ${summarizeParams(details.params)}` : undefined,
      typeof detailsAny?.asyncId === "string" ? `async: ${detailsAny.asyncId}` : undefined,
      typeof detailsAny?.asyncDir === "string" ? `async dir: ${detailsAny.asyncDir}` : undefined,
      artifacts?.dir ? `artifacts: ${artifacts.dir}` : undefined,
    ].filter((line): line is string => Boolean(line));
    for (const line of metaLines) addText(container, line, theme, "dim");
    if (metaLines.length > 0) addSpacer(container);
  }

  if (content.trim()) addMarkdown(container, content, theme);
  else addText(container, "(no text output)", theme, "dim");

  if (expanded && resultEntries.length > 0) {
    addSpacer(container);
    const detailBox = new Box(1, 1, (text: string) => theme.bg(isError ? "toolErrorBg" as never : "toolSuccessBg" as never, text));
    container.addChild(detailBox);
    addText(detailBox, "Agent details", theme, "toolTitle");
    addSpacer(detailBox);
    resultEntries.forEach((entry, index) => {
      addResultEntry(detailBox, entry, index, theme);
      if (index < resultEntries.length - 1) addSpacer(detailBox);
    });
  }

  const progress = progressEntries(details);
  if (expanded && progress.length > 0) {
    addSpacer(container);
    const progressBox = new Box(1, 1, (text: string) => theme.bg(isError ? "toolErrorBg" as never : "toolSuccessBg" as never, text));
    container.addChild(progressBox);
    addText(progressBox, "Progress summary", theme, "toolTitle");
    addSpacer(progressBox);
    addProgressEntries(progressBox, progress, true, theme);
  }

  return container;
}

function fallbackComponent(linesFactory: () => string[]): Component {
  return { render: () => linesFactory(), invalidate() {} };
}

function safeBuildComponent(build: () => Component, fallbackLines: () => string[], context: string): Component {
  try {
    return build();
  } catch (error) {
    logWorkflowDiagnostic(`pi-workflows renderer failed for ${context}.`, error);
    return fallbackComponent(fallbackLines);
  }
}

export function registerWorkflowRenderers(pi: ExtensionAPI): void {
  const rendererApi = pi as ExtensionAPI & {
    registerMessageRenderer?: (customType: string, renderer: (message: RenderMessageLike, options: MessageRenderOptions, theme: Theme) => unknown) => void;
  };
  rendererApi.registerMessageRenderer?.(WORKFLOW_PROGRESS_MESSAGE_TYPE, (message, options, theme) => safeBuildComponent(
    () => renderWorkflowProgressMessage(message, options, theme),
    () => [`workflow /${messageDetails(message).workflow ?? "unknown"} | ${messageDetails(message).status ?? "starting"}`],
    "progress",
  ));
  rendererApi.registerMessageRenderer?.(WORKFLOW_RESULT_MESSAGE_TYPE, (message, options, theme) => safeBuildComponent(
    () => renderWorkflowResultMessage(message, options, theme),
    () => [messageText(message.content) || `workflow /${messageDetails(message).workflow ?? "unknown"} result`],
    "result",
  ));
}
