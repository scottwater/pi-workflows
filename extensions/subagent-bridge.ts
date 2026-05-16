import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { logWorkflowDiagnostic } from "./messages.ts";
import type {
  AgentToolResult,
  SlashSubagentResponse,
  SlashSubagentTimeouts,
  SlashSubagentUpdate,
  SubagentParamsLike,
} from "./types.ts";

type RequestSubagentRunOptions = SlashSubagentTimeouts & {
  onStarted?: (requestId: string) => void;
  onUpdate?: (requestId: string, update: SlashSubagentUpdate) => void;
};

export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateContentItem(value: unknown, fieldPath: string): void {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  if (value.type !== undefined && typeof value.type !== "string") throw new Error(`${fieldPath}.type must be a string.`);
  if (value.text !== undefined && typeof value.text !== "string") throw new Error(`${fieldPath}.text must be a string.`);
  if (value.type === "text" && typeof value.text !== "string") throw new Error(`${fieldPath}.text must be a string for text content.`);
}

function validateResultEntry(value: unknown, fieldPath: string): void {
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  for (const key of ["agent", "task", "finalOutput", "error", "model", "sessionFile", "savedOutputPath"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${fieldPath}.${key} must be a string.`);
  }
  if (value.exitCode !== undefined && typeof value.exitCode !== "number") throw new Error(`${fieldPath}.exitCode must be a number.`);
}

function validateDetails(value: unknown, fieldPath: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${fieldPath} must be an object.`);
  for (const key of ["results", "partialFailures", "progress"] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key])) throw new Error(`${fieldPath}.${key} must be an array.`);
  }
  (value.results as unknown[] | undefined)?.forEach((entry, index) => validateResultEntry(entry, `${fieldPath}.results[${index}]`));
  (value.partialFailures as unknown[] | undefined)?.forEach((entry, index) => validateResultEntry(entry, `${fieldPath}.partialFailures[${index}]`));
  (value.progress as unknown[] | undefined)?.forEach((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${fieldPath}.progress[${index}] must be an object.`);
  });
}

function validateAgentToolResult(value: unknown, workflowName: string, requestId: string): AgentToolResult {
  const prefix = `Workflow /${workflowName} request ${requestId}: malformed pi-subagents response`;
  if (!isRecord(value)) throw new Error(`${prefix}: result must be an object.`);
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error(`${prefix}: result.isError must be a boolean.`);
  if (value.content !== undefined && !Array.isArray(value.content)) throw new Error(`${prefix}: result.content must be an array.`);
  (value.content as unknown[] | undefined)?.forEach((entry, index) => validateContentItem(entry, `${prefix}: result.content[${index}]`));
  validateDetails(value.details, `${prefix}: result.details`);
  return value as AgentToolResult;
}

export function normalizeSubagentResponse(data: unknown, workflowName: string, requestId: string): SlashSubagentResponse {
  const prefix = `Workflow /${workflowName} request ${requestId}: malformed pi-subagents response`;
  if (!isRecord(data)) throw new Error(`${prefix}: response must be an object.`);
  if (data.requestId !== requestId) throw new Error(`Workflow /${workflowName} request ${requestId}: received mismatched response id.`);
  if (data.isError !== undefined && typeof data.isError !== "boolean") throw new Error(`${prefix}: isError must be a boolean.`);
  if (data.errorText !== undefined && typeof data.errorText !== "string") throw new Error(`${prefix}: errorText must be a string.`);
  return {
    requestId,
    isError: data.isError === true,
    errorText: data.errorText,
    result: validateAgentToolResult(data.result, workflowName, requestId),
  };
}

export async function requestSubagentRun(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  requestId: string,
  params: SubagentParamsLike,
  workflowName: string,
  options: RequestSubagentRunOptions = {},
): Promise<SlashSubagentResponse> {
  const startTimeoutMs = options.startMs ?? 15_000;
  const responseTimeoutMs = options.responseMs ?? 60 * 60_000;

  return new Promise((resolvePromise, reject) => {
    let done = false;
    let responseTimeout: ReturnType<typeof setTimeout> | undefined;
    let unsubStarted = () => {};
    let unsubResponse = () => {};
    let unsubUpdate = () => {};

    const emitCancel = (reason: string) => {
      try {
        pi.events.emit(SLASH_SUBAGENT_CANCEL_EVENT, { requestId, workflowName, reason });
      } catch {
        // Cancellation is best-effort; preserve the original timeout/error path.
      }
    };

    const finish = (next: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(startTimeout);
      if (responseTimeout) clearTimeout(responseTimeout);
      unsubStarted();
      unsubResponse();
      unsubUpdate();
      next();
    };

    const startTimeout = setTimeout(() => {
      finish(() => {
        emitCancel("pi-subagents did not respond before startup timeout");
        reject(new Error(
          `Workflow /${workflowName} request ${requestId}: pi-subagents did not respond. ` +
          "Is the pi-subagents extension installed and loaded?",
        ));
      });
    }, startTimeoutMs);

    const armResponseTimeout = () => {
      if (responseTimeout) clearTimeout(responseTimeout);
      responseTimeout = setTimeout(() => {
        finish(() => {
          emitCancel("pi-subagents started but did not send a terminal response before timeout");
          reject(new Error(
            `Workflow /${workflowName} request ${requestId}: pi-subagents started but did not send a terminal response ` +
            `within ${Math.round(responseTimeoutMs / 1000)}s.`,
          ));
        });
      }, responseTimeoutMs);
    };

    const onStarted = (data: unknown) => {
      if (done || !isRecord(data) || data.requestId !== requestId) return;
      clearTimeout(startTimeout);
      armResponseTimeout();
      try {
        options.onStarted?.(requestId);
        if (ctx.hasUI) ctx.ui.setStatus?.("pi-workflows", "running workflow...");
      } catch (error) {
        logWorkflowDiagnostic(`Workflow /${workflowName} failed to update start UI state.`, error);
      }
    };

    const onResponse = (data: unknown) => {
      if (done || !isRecord(data) || data.requestId !== requestId) return;
      finish(() => {
        try {
          resolvePromise(normalizeSubagentResponse(data, workflowName, requestId));
        } catch (error) {
          reject(error);
        }
      });
    };

    const onUpdate = (data: unknown) => {
      if (done || !isRecord(data)) return;
      const update = data as SlashSubagentUpdate;
      if (update.requestId !== requestId) return;
      const first = update.progress?.[0];
      const tool = update.currentTool ?? first?.currentTool;
      const count = update.toolCount ?? first?.toolCount ?? 0;
      const label = first?.agent ? `${first.agent} ` : "";
      try {
        options.onUpdate?.(requestId, update);
        if (ctx.hasUI) ctx.ui.setStatus?.("pi-workflows", `${label}${count} tools${tool ? ` · ${tool}` : ""}`);
      } catch (error) {
        logWorkflowDiagnostic(`Workflow /${workflowName} failed to update progress UI state.`, error);
      }
    };

    unsubStarted = pi.events.on(SLASH_SUBAGENT_STARTED_EVENT, onStarted) as () => void;
    unsubResponse = pi.events.on(SLASH_SUBAGENT_RESPONSE_EVENT, onResponse) as () => void;
    unsubUpdate = pi.events.on(SLASH_SUBAGENT_UPDATE_EVENT, onUpdate) as () => void;

    pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params });
  });
}
