import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_PROGRESS_MESSAGE_TYPE,
  WORKFLOW_RESULT_MESSAGE_TYPE,
  clearWorkflowProgressWidget,
  logWorkflowDiagnostic,
  sendWorkflowMessage,
  sendWorkflowProgressMessage,
  setWorkflowProgressWidget,
} from "./messages.ts";
import { requestSubagentRun } from "./subagent-bridge.ts";
import { renderCompositeTemplate, renderTemplate, runtimeArgs, splitArgs } from "./templates.ts";
import type {
  AgentResultEntry,
  AgentRunnable,
  AgentToolResult,
  ChainStep,
  ParallelStep,
  Runnable,
  RuntimeArgs,
  SkillSpec,
  SlashSubagentResponse,
  SlashSubagentUpdate,
  SubagentChainStep,
  SubagentParamsLike,
  Workflow,
  WorkflowRunnable,
} from "./types.ts";
import { loadWorkflows } from "./workflow-schema.ts";

export function isWorkflowRunnable(step: unknown): step is WorkflowRunnable {
  return Boolean(step) && typeof step === "object" && typeof (step as { workflow?: unknown }).workflow === "string";
}

export function isParallelStep(step: ChainStep): step is ParallelStep {
  return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

function stepContainsNestedWorkflow(step: ChainStep): boolean {
  if (isParallelStep(step)) return step.parallel.some(isWorkflowRunnable);
  return isWorkflowRunnable(step);
}

export function workflowContainsNestedWorkflow(workflow: Workflow): boolean {
  return workflow.chain?.some(stepContainsNestedWorkflow) ?? false;
}

function stepNeedsLocalFailureTolerantExecution(step: ChainStep): boolean {
  return isParallelStep(step) && step.failFast === false;
}

function workflowNeedsCompositeExecution(workflow: Workflow): boolean {
  return workflowContainsNestedWorkflow(workflow) || (workflow.chain?.some(stepNeedsLocalFailureTolerantExecution) ?? false);
}

function skillSpecToArray(skill: SkillSpec | undefined): string[] | false | undefined {
  if (skill === undefined || skill === false) return skill;
  const values = Array.isArray(skill)
    ? skill.map((name) => name.trim())
    : skill.split(",").map((name) => name.trim()).filter(Boolean);
  return [...new Set(values)];
}

function mergeSkillSpecs(base: SkillSpec | undefined, override: SkillSpec | undefined): SkillSpec | undefined {
  if (override === false) return false;
  const baseValues = skillSpecToArray(base);
  const overrideValues = skillSpecToArray(override);
  if (overrideValues === false) return false;
  const merged = [...(baseValues && baseValues !== false ? baseValues : []), ...(overrideValues ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function applyTaskSkillDefault(task: AgentRunnable, skill: SkillSpec | undefined): AgentRunnable {
  if (skill === undefined) return task;
  const merged = mergeSkillSpecs(skill, task.skill);
  return merged === undefined ? task : { ...task, skill: merged };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function renderAgentRunnable(step: AgentRunnable, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): AgentRunnable {
  return stripUndefined({
    ...step,
    task: step.task ? renderTemplate(step.task, rawArgs, ctx, positional) : undefined,
  });
}

function renderWorkflowRunnable(step: WorkflowRunnable, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): WorkflowRunnable {
  return stripUndefined({
    ...step,
    args: step.args ? renderTemplate(step.args, rawArgs, ctx, positional) : undefined,
  });
}

function renderRunnable(step: Runnable, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): Runnable {
  return isWorkflowRunnable(step) ? renderWorkflowRunnable(step, rawArgs, ctx, positional) : renderAgentRunnable(step, rawArgs, ctx, positional);
}

function renderChainStep(step: ChainStep, rawArgs: string, ctx: ExtensionCommandContext, positional?: string[]): ChainStep {
  if (isParallelStep(step)) {
    return stripUndefined({
      parallel: step.parallel.map((task) => renderRunnable(task, rawArgs, ctx, positional)),
      failFast: step.failFast,
    });
  }
  return renderRunnable(step, rawArgs, ctx, positional);
}

function assertNoNestedWorkflowForSubagentParams(workflow: Workflow): void {
  if (workflowContainsNestedWorkflow(workflow)) {
    throw new Error(`Workflow ${workflow.name} contains nested workflow steps and cannot use the simple subagent fast path.`);
  }
}

function toSubagentChainStep(step: ChainStep): SubagentChainStep {
  if (isWorkflowRunnable(step)) throw new Error("Nested workflow runnable cannot be sent directly to pi-subagents.");
  if (isParallelStep(step)) {
    const parallel = step.parallel.map((entry) => {
      if (isWorkflowRunnable(entry)) throw new Error("Nested workflow runnable cannot be sent directly to pi-subagents.");
      return entry;
    });
    return stripUndefined({ parallel, failFast: step.failFast });
  }
  return step;
}

export function buildSubagentParams(
  workflow: Workflow,
  rawArgs: string,
  args: RuntimeArgs = runtimeArgs(rawArgs),
  ctx: ExtensionCommandContext,
): SubagentParamsLike {
  assertNoNestedWorkflowForSubagentParams(workflow);
  const positional = args.positional ?? splitArgs(rawArgs);
  const params: SubagentParamsLike = {};

  if (workflow.skill !== undefined && !workflow.tasks) params.skill = workflow.skill;

  if (workflow.chain) {
    params.chain = workflow.chain
      .map((step) => renderChainStep(step, rawArgs, ctx, positional))
      .map(toSubagentChainStep);
    params.task = rawArgs;
  } else if (workflow.tasks) {
    params.tasks = workflow.tasks
      .map((task) => renderAgentRunnable(task, rawArgs, ctx, positional))
      .map((task) => applyTaskSkillDefault(task, workflow.skill));
  } else if (workflow.agent && workflow.task !== undefined) {
    params.agent = workflow.agent;
    params.model = workflow.model;
    params.skill = mergeSkillSpecs(workflow.skill, undefined);
    params.task = renderTemplate(workflow.task, rawArgs, ctx, positional);
  }

  return stripUndefined(params);
}

function directText(result: AgentToolResult): string | undefined {
  const direct = result.content
    ?.filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return direct || undefined;
}

function resultEntryFailed(entry: AgentResultEntry): boolean {
  return Boolean(entry.error) || (typeof entry.exitCode === "number" && entry.exitCode !== 0);
}

function failedResultEntries(result: AgentToolResult): AgentResultEntry[] {
  return result.details?.results?.filter(resultEntryFailed) ?? [];
}

function partialFailureEntries(result: AgentToolResult): AgentResultEntry[] {
  return result.details?.partialFailures ?? [];
}

function resultHasFailure(result: AgentToolResult): boolean {
  return result.isError === true || failedResultEntries(result).length > 0 || partialFailureEntries(result).length > 0;
}

function extractSuccessText(result: AgentToolResult): string {
  const results = result.details?.results ?? [];
  const lastSuccessfulOutput = [...results]
    .reverse()
    .find((entry) => entry.exitCode === 0 && typeof entry.finalOutput === "string" && entry.finalOutput.trim())
    ?.finalOutput
    ?.trim();
  const lastOutput = [...results]
    .reverse()
    .find((entry) => typeof entry.finalOutput === "string" && entry.finalOutput.trim())
    ?.finalOutput
    ?.trim();
  return lastSuccessfulOutput ?? lastOutput ?? directText(result) ?? "Workflow completed.";
}

function extractErrorText(response: SlashSubagentResponse): string {
  const failed = [...failedResultEntries(response.result), ...partialFailureEntries(response.result)];
  const failedText = failed
    .map((entry) => entry.error ?? entry.finalOutput)
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n\n")
    .trim();
  return response.errorText ?? failedText ?? directText(response.result) ?? "Workflow failed.";
}

function formatResponseText(response: SlashSubagentResponse): string {
  return response.isError || resultHasFailure(response.result)
    ? extractErrorText(response)
    : extractSuccessText(response.result);
}

type WorkflowRunResult = {
  ok: boolean;
  text: string;
  errorText?: string;
  details: AgentToolResult;
  requestId?: string;
  params?: SubagentParamsLike;
};

type ExecutionOptions = {
  stack: string[];
  onProgress?: (requestId: string, update: SlashSubagentUpdate) => void;
};

function responseToWorkflowRunResult(response: SlashSubagentResponse): WorkflowRunResult {
  const ok = !response.isError && !resultHasFailure(response.result);
  const text = formatResponseText(response);
  const errorText = ok ? undefined : extractErrorText(response);
  return {
    ok,
    text,
    errorText,
    details: response.result,
    requestId: response.requestId,
  };
}

function workflowRunResultFromError(error: unknown): WorkflowRunResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    text: message,
    errorText: message,
    details: {
      content: [{ type: "text", text: message }],
      isError: true,
      details: { mode: "composite", results: [], warnings: ["Child runnable threw before returning a workflow result."] },
    },
  };
}

async function executeSimpleWorkflowForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflow: Workflow,
  rawArgs: string,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  const params = buildSubagentParams(workflow, rawArgs, runtimeArgs(rawArgs), ctx);
  const requestId = randomUUID();
  const response = await requestSubagentRun(pi, ctx, requestId, params, workflow.name, {
    onUpdate: options.onProgress,
  });
  const result = responseToWorkflowRunResult(response);
  result.params = params;
  return result;
}

function workflowRunResultHasFailure(result: WorkflowRunResult): boolean {
  return !result.ok || resultHasFailure(result.details);
}

function resultEntryFromRun(label: string, result: WorkflowRunResult): AgentResultEntry {
  const failed = workflowRunResultHasFailure(result);
  return {
    agent: label,
    finalOutput: result.text,
    error: failed ? result.errorText ?? (!result.ok ? result.text : "Completed with partial failures.") : undefined,
    exitCode: failed ? 1 : 0,
  };
}

function mergeAgentToolResults(
  text: string,
  results: AgentResultEntry[],
  ok: boolean,
  partialFailures: AgentResultEntry[] = [],
  warnings: string[] = [],
): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    isError: !ok || partialFailures.length > 0,
    details: stripUndefined({
      mode: "composite",
      results,
      partialFailures: partialFailures.length ? partialFailures : undefined,
      warnings: warnings.length ? warnings : undefined,
    }),
  };
}

function runnableLabel(runnable: Runnable): string {
  return isWorkflowRunnable(runnable) ? `Workflow: ${runnable.workflow}` : `Agent: ${runnable.agent}`;
}

function aggregateRunnableResults(results: Array<{ runnable: Runnable; result: WorkflowRunResult; label?: string }>): string {
  return results
    .map(({ runnable, result, label }) => {
      const status = workflowRunResultHasFailure(result) ? (result.ok ? "partial" : "failed") : "ok";
      return `=== ${label ?? runnableLabel(runnable)} (${status}) ===\n${result.text}`;
    })
    .join("\n\n");
}

function renderRunnableTask(
  step: AgentRunnable,
  rawArgs: string,
  ctx: ExtensionCommandContext,
  positional: string[],
  previous: string,
  index: number,
): string {
  if (step.task !== undefined) return renderCompositeTemplate(step.task, rawArgs, ctx, positional, previous, rawArgs);
  return index === 0 ? rawArgs : previous;
}

async function executeAgentRunnableForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parentWorkflow: Workflow,
  step: AgentRunnable,
  rawArgs: string,
  previous: string,
  index: number,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  const positional = splitArgs(rawArgs);
  const effectiveStep = applyTaskSkillDefault(step, parentWorkflow.skill);
  const params: SubagentParamsLike = stripUndefined({
    agent: effectiveStep.agent,
    task: renderRunnableTask(effectiveStep, rawArgs, ctx, positional, previous, index),
    model: effectiveStep.model,
    skill: effectiveStep.skill,
  });
  const requestId = randomUUID();
  const response = await requestSubagentRun(pi, ctx, requestId, params, parentWorkflow.name, {
    onUpdate: options.onProgress,
  });
  const result = responseToWorkflowRunResult(response);
  result.params = params;
  return result;
}

function projectWorkflowDir(cwd: string): string {
  return resolve(join(cwd, ".pi", "workflows"));
}

function workflowIsProjectLocal(workflow: Workflow, cwd: string): boolean {
  const rel = relative(projectWorkflowDir(cwd), resolve(workflow.sourcePath));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function projectDiscoveryWarning(cwd: string, warnings: Array<{ path: string; error: string }>): { path: string; error: string } | undefined {
  const projectDir = projectWorkflowDir(cwd);
  return warnings.find((warning) => resolve(warning.path) === projectDir && /project workflow directory could not be read/.test(warning.error));
}

function lookupWorkflow(cwd: string, name: string): Workflow {
  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings);
  const workflow = workflows.find((candidate) => candidate.name === name);
  const projectWarning = projectDiscoveryWarning(cwd, warnings);
  if (projectWarning && (!workflow || !workflowIsProjectLocal(workflow, cwd))) {
    throw new Error(`Nested workflow lookup for ${name} refused because project workflows could not be read: ${projectWarning.path}: ${projectWarning.error}`);
  }
  if (!workflow) {
    const warningText = warnings.length ? ` Skipped workflow warnings: ${warnings.map((warning) => `${warning.path}: ${warning.error}`).join("; ")}` : "";
    throw new Error(`Nested workflow not found: ${name}.${warningText}`);
  }
  return workflow;
}

async function executeWorkflowRunnableForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parentWorkflow: Workflow,
  step: WorkflowRunnable,
  rawArgs: string,
  previous: string,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  const positional = splitArgs(rawArgs);
  const childArgs = renderCompositeTemplate(step.args ?? "{{args}}", rawArgs, ctx, positional, previous, rawArgs);
  const child = lookupWorkflow(ctx.cwd, step.workflow);
  return executeWorkflowForResult(pi, ctx, child, childArgs, options);
}

async function executeRunnableForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parentWorkflow: Workflow,
  step: Runnable,
  rawArgs: string,
  previous: string,
  index: number,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  return isWorkflowRunnable(step)
    ? executeWorkflowRunnableForResult(pi, ctx, parentWorkflow, step, rawArgs, previous, options)
    : executeAgentRunnableForResult(pi, ctx, parentWorkflow, step, rawArgs, previous, index, options);
}

async function executeParallelStepForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflow: Workflow,
  step: ParallelStep,
  rawArgs: string,
  previous: string,
  index: number,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  const failFast = step.failFast !== false;
  const results = await Promise.all(step.parallel.map(async (runnable) => {
    try {
      return await executeRunnableForResult(pi, ctx, workflow, runnable, rawArgs, previous, index, options);
    } catch (error) {
      return workflowRunResultFromError(error);
    }
  }));
  const paired = step.parallel.map((runnable, resultIndex) => ({ runnable, result: results[resultIndex]! }));
  const entries = paired.map(({ runnable, result }) => resultEntryFromRun(runnableLabel(runnable), result));
  const childPartialFailures = paired.flatMap(({ result }) => result.details.details?.partialFailures ?? []);
  const partialFailures = [...entries.filter((entry) => resultEntryFailed(entry)), ...childPartialFailures];
  const aggregate = aggregateRunnableResults(paired);
  const failed = paired.find(({ result }) => workflowRunResultHasFailure(result));
  const childWarnings = paired.flatMap(({ result }) => result.details.details?.warnings ?? []);

  if (failed && failFast) {
    return {
      ok: false,
      text: failed.result.errorText ?? failed.result.text,
      errorText: failed.result.errorText ?? failed.result.text,
      details: mergeAgentToolResults(aggregate, entries, false, partialFailures, childWarnings),
    };
  }

  const warnings = [
    ...childWarnings,
    partialFailures.length > 0
      ? `Parallel step ${index + 1} completed with ${partialFailures.length} failed child runnable${partialFailures.length === 1 ? "" : "s"}.`
      : undefined,
  ].filter((warning): warning is string => Boolean(warning));
  return {
    ok: true,
    text: aggregate,
    details: mergeAgentToolResults(aggregate, entries, true, partialFailures, warnings),
  };
}

async function executeCompositeWorkflowForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflow: Workflow,
  rawArgs: string,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  if (!workflow.chain) throw new Error(`Composite workflow /${workflow.name} must define a chain.`);
  const entries: AgentResultEntry[] = [];
  const partialFailures: AgentResultEntry[] = [];
  const warnings: string[] = [];
  let previous = "";

  for (const [index, step] of workflow.chain.entries()) {
    const result = isParallelStep(step)
      ? await executeParallelStepForResult(pi, ctx, workflow, step, rawArgs, previous, index, options)
      : await executeRunnableForResult(pi, ctx, workflow, step, rawArgs, previous, index, options);
    entries.push(...(result.details.details?.results ?? [resultEntryFromRun(isParallelStep(step) ? `Parallel step ${index + 1}` : runnableLabel(step), result)]));
    partialFailures.push(...(result.details.details?.partialFailures ?? []));
    warnings.push(...(result.details.details?.warnings ?? []));
    if (!result.ok) {
      return {
        ok: false,
        text: result.text,
        errorText: result.errorText ?? result.text,
        details: mergeAgentToolResults(result.text, entries, false, partialFailures, warnings),
      };
    }
    previous = result.text;
  }

  return {
    ok: true,
    text: previous || "(workflow completed with no text output)",
    details: mergeAgentToolResults(previous, entries, true, partialFailures, warnings),
  };
}

async function executeWorkflowForResult(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflow: Workflow,
  rawArgs: string,
  options: ExecutionOptions,
): Promise<WorkflowRunResult> {
  if (options.stack.includes(workflow.name)) {
    throw new Error(`Workflow composition recursion detected: ${[...options.stack, workflow.name].join(" -> ")}`);
  }
  const childOptions = { ...options, stack: [...options.stack, workflow.name] };
  return workflowNeedsCompositeExecution(workflow)
    ? executeCompositeWorkflowForResult(pi, ctx, workflow, rawArgs, childOptions)
    : executeSimpleWorkflowForResult(pi, ctx, workflow, rawArgs, childOptions);
}

function previewParams(workflow: Workflow, rawArgs: string, ctx: ExtensionCommandContext): SubagentParamsLike {
  if (workflowContainsNestedWorkflow(workflow)) return { task: rawArgs };
  return buildSubagentParams(workflow, rawArgs, runtimeArgs(rawArgs), ctx);
}

function safeNotify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, level);
  } catch (error) {
    logWorkflowDiagnostic(`Workflow UI notification failed: ${message}`, error);
  }
}

function safeSetStatus(ctx: ExtensionCommandContext, value: string | undefined): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus?.("pi-workflows", value);
  } catch (error) {
    logWorkflowDiagnostic("Workflow UI status update failed.", error);
  }
}

export async function runWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, workflow: Workflow, args: string): Promise<void> {
  const requestId = randomUUID();
  let params: SubagentParamsLike | undefined;
  let responseFailure: Error | undefined;

  const liveProgress = new Map<string, NonNullable<SlashSubagentUpdate["progress"]>>();
  const updateLiveProgress = (childRequestId: string, update: SlashSubagentUpdate): void => {
    liveProgress.set(childRequestId, update.progress ?? []);
    const progress = [...liveProgress.values()].flat();
    setWorkflowProgressWidget(ctx, workflow.name, {
      workflow: workflow.name,
      sourcePath: workflow.sourcePath,
      requestId,
      params,
      status: "running",
      progress,
    });
  };

  safeNotify(ctx, `Running workflow /${workflow.name}`, "info");

  try {
    params = previewParams(workflow, args, ctx);
    sendWorkflowProgressMessage(pi, ctx, {
      customType: WORKFLOW_PROGRESS_MESSAGE_TYPE,
      content: `▶ Running workflow /${workflow.name}...`,
      display: true,
      details: { workflow: workflow.name, sourcePath: workflow.sourcePath, requestId, params, status: "starting", progress: [] },
    });

    const result = await executeWorkflowForResult(pi, ctx, workflow, args, { stack: [], onProgress: updateLiveProgress });
    const effectiveIsError = !result.ok || result.details.isError === true;
    const finalParams = result.params ?? params;
    const workflowError = !result.ok ? new Error(`Workflow /${workflow.name} failed: ${result.errorText ?? result.text}`) : undefined;
    setWorkflowProgressWidget(ctx, workflow.name, { workflow: workflow.name, requestId, params: finalParams, status: effectiveIsError ? "failed" : "completed", result: result.details });
    try {
      sendWorkflowMessage(pi, ctx, {
        customType: WORKFLOW_RESULT_MESSAGE_TYPE,
        content: result.text,
        display: true,
        details: {
          workflow: workflow.name,
          sourcePath: workflow.sourcePath,
          requestId,
          params: finalParams,
          isError: effectiveIsError,
          errorText: result.errorText,
          result: result.details,
        },
      });
    } catch (reportingError) {
      if (workflowError) {
        throw new AggregateError(
          [workflowError, reportingError].filter((failure): failure is Error => failure instanceof Error),
          `Workflow /${workflow.name} failed and failed to report final result: ${result.errorText ?? result.text}`,
        );
      }
      throw reportingError;
    }

    if (workflowError) {
      responseFailure = workflowError;
      safeNotify(ctx, result.errorText ?? "Workflow failed", "error");
    } else {
      safeNotify(
        ctx,
        effectiveIsError ? `Workflow /${workflow.name} completed with partial failures` : `Workflow /${workflow.name} completed`,
        effectiveIsError ? "warning" : "info",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      sendWorkflowMessage(pi, ctx, {
        customType: WORKFLOW_RESULT_MESSAGE_TYPE,
        content: `Workflow /${workflow.name} failed: ${message}`,
        display: true,
        details: { workflow: workflow.name, sourcePath: workflow.sourcePath, requestId, params, isError: true, error: message },
      });
    } catch (reportingError) {
      throw new AggregateError(
        [error, reportingError].filter((failure): failure is Error => failure instanceof Error),
        `Workflow /${workflow.name} failed and failed to report error result: ${message}`,
      );
    }
    safeNotify(ctx, message, "error");
    throw error;
  } finally {
    safeSetStatus(ctx, undefined);
    clearWorkflowProgressWidget(ctx);
  }

  if (responseFailure) throw responseFailure;
}

export function listWorkflowText(workflows: Workflow[], warnings: Array<{ path: string; error: string }> = []): string {
  const workflowText = workflows.length === 0
    ? "No workflows found."
    : workflows
      .map((workflow) => `/${workflow.name}${workflow.description ? ` — ${workflow.description}` : ""}\n  ${workflow.sourcePath}`)
      .join("\n");
  if (warnings.length === 0) return workflowText;
  const warningText = warnings
    .map((warning) => `- ${warning.path}: ${warning.error}`)
    .join("\n");
  return `${workflowText}\n\nSkipped invalid workflow file(s):\n${warningText}`;
}

export function workflowLoadSummary(workflows: Workflow[], warnings: Array<{ path: string; error: string }>): string {
  return `pi-workflows loaded ${workflows.length} workflow(s)${warnings.length ? `, skipped ${warnings.length} invalid file(s)` : ""}`;
}
