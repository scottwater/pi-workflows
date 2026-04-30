import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerPiWorkflows, {
  buildSubagentParams,
  loadWorkflows,
  parseWorkflowFile,
  requestSubagentRun,
  runWorkflow,
} from "../extensions/index.ts";

const REQUEST_EVENT = "subagent:slash:request";
const STARTED_EVENT = "subagent:slash:started";
const RESPONSE_EVENT = "subagent:slash:response";
const CANCEL_EVENT = "subagent:slash:cancel";

const testTheme = {
  fg: (_name: string, text: string) => text,
  bg: (_name: string, text: string) => text,
  bold: (text: string) => text,
};

type Listener = (data: unknown) => void;

function withTempHome<T>(fn: (home: string) => T): T {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-home-"));
  const restore = () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const result = fn(home);
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      return Promise.resolve(result).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function createEvents() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    emit(event: string, data: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(data);
    },
  };
}

function createCtx(cwd = process.cwd()) {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
    },
  };
}

test("slash bridge waits for asynchronous started and response events", async () => {
  const events = createEvents();
  const pi = { events };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: "unrelated" });
      events.emit(RESPONSE_EVENT, {
        requestId: "unrelated",
        isError: false,
        result: { content: [{ type: "text", text: "wrong" }] },
      });
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }, 0);
  });

  const response = await requestSubagentRun(pi as any, createCtx() as any, "req-1", { agent: "a", task: "t" }, "wf");
  assert.equal(response.requestId, "req-1");
  assert.equal(response.isError, false);
  assert.equal(response.result.content?.[0]?.text, "ok");
});

test("slash bridge rejects and requests cancellation when pi-subagents never starts", async () => {
  const events = createEvents();
  const pi = { events };
  const cancellations: any[] = [];

  events.on(CANCEL_EVENT, (data) => cancellations.push(data));

  await assert.rejects(
    requestSubagentRun(
      pi as any,
      createCtx() as any,
      "req-no-start",
      { agent: "a", task: "t" },
      "timeout-wf",
      { startMs: 10, responseMs: 50 },
    ),
    /Workflow \/timeout-wf request req-no-start: pi-subagents did not respond/,
  );
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].requestId, "req-no-start");
});

test("slash bridge rejects and requests cancellation when started run never sends terminal response", async () => {
  const events = createEvents();
  const pi = { events };
  const cancellations: any[] = [];

  events.on(CANCEL_EVENT, (data) => cancellations.push(data));
  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => events.emit(STARTED_EVENT, { requestId: request.requestId }), 0);
  });

  await assert.rejects(
    requestSubagentRun(
      pi as any,
      createCtx() as any,
      "req-timeout",
      { agent: "a", task: "t" },
      "timeout-wf",
      { startMs: 50, responseMs: 10 },
    ),
    /Workflow \/timeout-wf request req-timeout: pi-subagents started but did not send a terminal response/,
  );
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].requestId, "req-timeout");
});

test("model overrides are rejected by agent policy and forwarded by workflow policy", () => {
  const workflow = {
    name: "model-test",
    sourcePath: "model-test.jsonc",
    modelPolicy: "workflow",
    agent: "reviewer",
    model: "anthropic/claude-opus-4-5",
    task: "Review {{args}}",
  };

  const params = buildSubagentParams(workflow as any, "the diff", { args: "", positional: ["the", "diff"] } as any, createCtx() as any);
  assert.equal(params.agent, "reviewer");
  assert.equal(params.model, "anthropic/claude-opus-4-5");
  assert.equal(params.task, "Review the diff");

  assert.throws(
    () => buildSubagentParams({ ...workflow, modelPolicy: "agent" } as any, "the diff", { args: "", positional: ["the", "diff"] } as any, createCtx() as any),
    /modelPolicy=agent.*model override/,
  );

  const chained = {
    name: "nested-model-test",
    sourcePath: "nested-model-test.jsonc",
    modelPolicy: "agent",
    chain: [
      { agent: "first", task: "one", model: "anthropic/claude-opus-4-5" },
      { parallel: [{ agent: "second", task: "two", model: "google/gemini-3-pro" }] },
    ],
  };
  assert.throws(
    () => buildSubagentParams(chained as any, "", { args: "", positional: [] } as any, createCtx() as any),
    /modelPolicy=agent.*model override/,
  );
  const chainedParams = buildSubagentParams({ ...chained, modelPolicy: "workflow" } as any, "", { args: "", positional: [] } as any, createCtx() as any);
  assert.equal((chainedParams.chain?.[0] as any).model, "anthropic/claude-opus-4-5");
  assert.equal((chainedParams.chain?.[1] as any).parallel[0].model, "google/gemini-3-pro");
});

test("workflow custom messages force a session snapshot even before an assistant message exists", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const rewrites: number[] = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-workflows-session-snapshot-"));
  const sessionFile = join(sessionDir, "session.jsonl");
  const sessionManager = {
    flushed: false,
    getSessionFile() {
      return sessionFile;
    },
    _rewriteFile() {
      rewrites.push(messages.length);
    },
  };
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: { content: [{ type: "text", text: "final review" }], details: { results: [] } },
      });
    }, 0);
  });

  await runWorkflow(
    pi as any,
    { ...createCtx(), sessionManager } as any,
    { name: "snapshot-test", sourcePath: "snapshot-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
    "",
  );

  assert.deepEqual(messages.map((message) => message.customType), ["pi-workflows-progress", "pi-workflows-result"]);
  assert.deepEqual(rewrites, [1, 2]);
  assert.equal(sessionManager.flushed, true);
});

test("review workflows recover synthesized output from no-edit completion guard failures", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
  };

  const synthesizedReview = "## Summary\n\nFinal synthesized review output.";
  const guardError = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: true,
        result: {
          content: [{ type: "text", text: `❌ Chain failed: ${guardError}` }],
          details: {
            results: [{
              agent: "review-synthesizer",
              exitCode: 1,
              error: guardError,
              finalOutput: synthesizedReview,
            }],
          },
        },
      });
    }, 0);
  });

  await runWorkflow(
    pi as any,
    createCtx() as any,
    { name: "review-agents", description: "Multi-agent code review", sourcePath: "review-agents.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
    "",
  );

  const result = messages.find((message) => message.customType === "pi-workflows-result");
  assert.ok(result);
  assert.equal(result.details.isError, false);
  assert.equal(result.details.recoveredCompletionGuard, true);
  assert.match(result.content, /completion-guard failure/);
  assert.match(result.content, /Final synthesized review output/);
});

test("runtime flag extraction preserves quoted positional arguments", async () => {
  const events = createEvents();
  const requests: any[] = [];
  const pi = {
    events,
    sendMessage() {},
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: any };
    requests.push(request);
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }, 0);
  });

  await runWorkflow(
    pi as any,
    createCtx() as any,
    {
      name: "quoted-test",
      sourcePath: "quoted-test.jsonc",
      agent: "a",
      task: "first={{1}} second={{2}} args={{args}}",
      modelPolicy: "agent",
    } as any,
    '"two words" --fork next --clarify',
  );

  assert.equal(requests[0].params.context, "fork");
  assert.equal(requests[0].params.clarify, true);
  assert.equal(requests[0].params.task, "first=two words second=next args=two words next");
});

test("JSONC parsing removes comments and trailing commas without rewriting prompt strings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-parser-"));
  const file = join(dir, "workflow.jsonc");
  writeFileSync(
    file,
    `{
      // comment
      "name": "parser-test",
      "agent": "reviewer",
      "task": "Keep these exact snippets: \\", }\\" and \\", ]\\"",
      "chain": [
        { "agent": "a", "task": "t" },
      ],
    }`,
  );

  const workflow = parseWorkflowFile(file)!;
  assert.equal(workflow.task, "Keep these exact snippets: \", }\" and \", ]\"");
  assert.equal(workflow.chain?.length, 1);
});

test("loadWorkflows skips malformed files while loading valid workflows", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-load-"));
  const workflowDir = join(cwd, ".pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "good.jsonc"), `{ "name": "good-load-test", "agent": "a", "task": "t" }`);
  writeFileSync(join(workflowDir, "bad.jsonc"), `{ "name": "bad-load-test", `);

  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings, true, ["project"]);
  assert.ok(workflows.some((workflow) => workflow.name === "good-load-test"));
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad.jsonc") && warning.error));
});

test("loadWorkflows skips structurally invalid workflow files with warnings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-schema-"));
  const workflowDir = join(cwd, ".pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, "good.jsonc"), `{ "name": "schema-good", "agent": "a", "task": "t", "forkFallback": "error" }`);
  writeFileSync(join(workflowDir, "bad-chain.jsonc"), `{ "name": "bad-chain", "chain": {} }`);
  writeFileSync(join(workflowDir, "bad-task.jsonc"), `{ "name": "bad-task", "agent": "a", "task": {} }`);
  writeFileSync(join(workflowDir, "bad-policy.jsonc"), `{ "name": "bad-policy", "agent": "a", "task": "t", "modelPolicy": "typo" }`);
  writeFileSync(join(workflowDir, "bad-fallback.jsonc"), `{ "name": "bad-fallback", "agent": "a", "task": "t", "forkFallback": "typo" }`);

  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings, true, ["project"]);
  assert.deepEqual(workflows.map((workflow) => workflow.name), ["schema-good"]);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-chain.jsonc") && /chain must be an array/.test(warning.error)));
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-task.jsonc") && /task must be a string/.test(warning.error)));
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-policy.jsonc") && /modelPolicy must be one of/.test(warning.error)));
  assert.ok(warnings.some((warning) => warning.path.endsWith("bad-fallback.jsonc") && /forkFallback must be one of/.test(warning.error)));
});

test("directory-level workflow discovery errors are reported as warnings", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-dir-warning-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "workflows"), "not a directory");

  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings, true, ["project"]);
  assert.deepEqual(workflows, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].path.endsWith(join(".pi", "workflows")));
  assert.match(warnings[0].error, /not a directory|could not be read/);
});

test("malformed project workflow shadows same-named global workflow when name is extractable", () => withTempHome((home) => {
  const globalDir = join(home, ".pi", "agent", "workflows");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "shadow.jsonc"), `{ "name": "shadow-test", "agent": "global", "task": "global" }`);

  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-shadow-"));
  const projectDir = join(cwd, ".pi", "workflows");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "shadow.jsonc"), `{ "name": "shadow-test", `);

  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings);
  assert.equal(workflows.some((workflow) => workflow.name === "shadow-test"), false);
  assert.ok(warnings.some((warning) => warning.path.endsWith("shadow.jsonc") && warning.error));
}));

test("malformed project workflow without extractable name does not shadow global by filename", () => withTempHome((home) => {
  const globalDir = join(home, ".pi", "agent", "workflows");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "review.jsonc"), `{ "name": "review", "agent": "global", "task": "global" }`);

  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-no-shadow-"));
  const projectDir = join(cwd, ".pi", "workflows");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "review.jsonc"), `{ "agent": "project", `);

  const warnings: Array<{ path: string; error: string }> = [];
  const workflows = loadWorkflows(cwd, warnings);
  assert.equal(workflows.some((workflow) => workflow.name === "review"), true);
  assert.ok(warnings.some((warning) => warning.path.endsWith("review.jsonc") && warning.error));
}));

test("runWorkflow renders error responses as failures and propagates failure", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: true,
        errorText: "agent failed loudly",
        result: {
          details: {
            results: [
              { agent: "first", exitCode: 0, finalOutput: "successful output should not be shown" },
              { agent: "second", exitCode: 1, error: "second failed" },
            ],
          },
        },
      });
    }, 0);
  });

  await assert.rejects(
    runWorkflow(
      pi as any,
      createCtx() as any,
      { name: "error-test", sourcePath: "error-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
      "",
    ),
    /agent failed loudly/,
  );

  const result = messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.equal(result.details.errorText, "agent failed loudly");
  assert.equal(result.content, "agent failed loudly");
  assert.doesNotMatch(result.content, /successful output/);
});

test("runWorkflow treats nested result failures as failed even without top-level isError", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        result: {
          isError: true,
          details: { results: [{ agent: "bad", exitCode: 1, finalOutput: "nested failed" }] },
        },
      });
    }, 0);
  });

  await assert.rejects(
    runWorkflow(
      pi as any,
      createCtx() as any,
      { name: "nested-error-test", sourcePath: "nested-error-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
      "",
    ),
    /nested failed/,
  );

  const result = messages.find((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.isError, true);
  assert.equal(result.details.errorText, "nested failed");
  assert.equal(result.content, "nested failed");
});

test("workflow result renderer marks error-only agent results as failed", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const renderers = new Map<string, any>();
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
    registerCommand() {},
    on() {},
    registerMessageRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
  };

  registerPiWorkflows(pi as any);

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: {
          details: { results: [{ agent: "reviewer", error: "timed out before finishing" }] },
        },
      });
    }, 0);
  });

  await assert.rejects(
    runWorkflow(
      pi as any,
      createCtx() as any,
      { name: "error-only-render-test", sourcePath: "error-only-render-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
      "",
    ),
    /timed out before finishing/,
  );

  const resultRenderer = renderers.get("pi-workflows-result");
  assert.ok(resultRenderer);
  const resultMessage = messages.find((message) => message.customType === "pi-workflows-result");
  const expandedLines = resultRenderer(resultMessage, { expanded: true }).render(120).join("\n");
  assert.match(expandedLines, /✗ reviewer · failed/);
  assert.doesNotMatch(expandedLines, /✓ reviewer · done/);
});

test("malformed subagent responses reject with workflow context and reporting failures do not mask the original", async () => {
  const events = createEvents();
  const pi = {
    events,
    sendMessage(message: any) {
      if (message.customType === "pi-workflows-result") throw new Error("send failed");
    },
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, { requestId: request.requestId, isError: false });
    }, 0);
  });

  await assert.rejects(
    runWorkflow(
      pi as any,
      createCtx() as any,
      { name: "malformed-response-test", sourcePath: "malformed-response-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
      "",
    ),
    /Workflow \/malformed-response-test request .*malformed pi-subagents response: result must be an object/,
  );
});

test("fork fallback retries once with fresh context", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const renderers = new Map<string, any>();
  const seenContexts: string[] = [];
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
    },
    registerCommand() {},
    on() {},
    registerMessageRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
  };

  registerPiWorkflows(pi as any);

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: { context?: string } };
    seenContexts.push(request.params.context ?? "");
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      if (seenContexts.length === 1) {
        events.emit(RESPONSE_EVENT, {
          requestId: request.requestId,
          isError: true,
          errorText: "Failed to create forked subagent session",
          result: { content: [{ type: "text", text: "fork failed" }] },
        });
      } else {
        events.emit(RESPONSE_EVENT, {
          requestId: request.requestId,
          isError: false,
          result: { content: [{ type: "text", text: "fresh ok" }] },
        });
      }
    }, 0);
  });

  await runWorkflow(
    pi as any,
    createCtx() as any,
    { name: "fork-test", sourcePath: "fork-test.jsonc", agent: "a", task: "t", context: "fork", modelPolicy: "agent" } as any,
    "",
  );

  assert.deepEqual(seenContexts, ["fork", "fresh"]);
  const result = messages.findLast((message) => message.customType === "pi-workflows-result");
  assert.equal(result.details.retriedFromFork, true);
  assert.match(result.content, /fresh ok/);

  const progressRenderer = renderers.get("pi-workflows-progress");
  assert.ok(progressRenderer);
  const progressMessages = messages.filter((message) => message.customType === "pi-workflows-progress");
  assert.equal(progressMessages.length, 2);
  const firstProgressLines = progressRenderer(progressMessages[0], { expanded: false }).render(120).join("\n");
  assert.match(firstProgressLines, /workflow \/fork-test \| failed/);
  assert.doesNotMatch(firstProgressLines, /Running workflow/);
  const firstExpandedProgressLines = progressRenderer(progressMessages[0], { expanded: true }).render(120).join("\n");
  assert.match(firstExpandedProgressLines, /params: single · a · fork/);
});

test("forkFallback error disables fresh-context retry", async () => {
  const events = createEvents();
  const seenContexts: string[] = [];
  const pi = {
    events,
    sendMessage() {},
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: { context?: string } };
    seenContexts.push(request.params.context ?? "");
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: true,
        errorText: "Failed to create forked subagent session",
        result: { content: [{ type: "text", text: "fork failed" }] },
      });
    }, 0);
  });

  await assert.rejects(
    runWorkflow(
      pi as any,
      createCtx() as any,
      {
        name: "fork-error-test",
        sourcePath: "fork-error-test.jsonc",
        agent: "a",
        task: "t",
        context: "fork",
        forkFallback: "error",
        modelPolicy: "agent",
      } as any,
      "",
    ),
    /Failed to create forked subagent session/,
  );

  assert.deepEqual(seenContexts, ["fork"]);
});

test("workflow list command renders skipped-file warnings", () => withTempHome((home) => {
  void home;
  const repo = mkdtempSync(join(tmpdir(), "pi-workflows-list-warning-"));
  const projectDir = join(repo, ".pi", "workflows");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "good.jsonc"), `{ "name": "list-good", "agent": "a", "task": "t" }`);
  writeFileSync(join(projectDir, "bad.jsonc"), `{ "name": "list-bad", "chain": {} }`);

  const commands = new Map<string, any>();
  const messages: any[] = [];
  const pi = {
    sendMessage(message: any) {
      messages.push(message);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on() {},
  };

  registerPiWorkflows(pi as any);
  commands.get("workflow").handler("--list", createCtx(repo));

  assert.match(messages[0].content, /\/list-good/);
  assert.match(messages[0].content, /Skipped invalid workflow file\(s\):/);
  assert.match(messages[0].content, /bad\.jsonc/);
}));

test("project workflow overrides same-named global direct command during execution", async () => withTempHome(async (home) => {
  const globalDir = join(home, ".pi", "agent", "workflows");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "override.jsonc"), `{ "name": "override-test", "agent": "a", "task": "global {{args}}" }`);

  const repo = mkdtempSync(join(tmpdir(), "pi-workflows-override-"));
  const projectDir = join(repo, ".pi", "workflows");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "override.jsonc"), `{ "name": "override-test", "agent": "a", "task": "project {{args}}" }`);

  const commands = new Map<string, any>();
  const slashEvents = createEvents();
  const requests: any[] = [];
  const pi = {
    events: slashEvents,
    sendMessage() {},
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on() {},
  };

  slashEvents.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string; params: any };
    requests.push(request);
    setTimeout(() => {
      slashEvents.emit(STARTED_EVENT, { requestId: request.requestId });
      slashEvents.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }] },
      });
    }, 0);
  });

  registerPiWorkflows(pi as any);
  assert.ok(commands.has("override-test"));
  await commands.get("override-test").handler("arg", createCtx(repo));
  assert.equal(requests[0].params.task, "project arg");
}));

test("workflow live widget shows pending details without requiring expansion", async () => {
  const events = createEvents();
  const widgets: any[] = [];
  const pi = {
    events,
    sendMessage() {},
  };
  const ctx = {
    ...createCtx(),
    hasUI: true,
    ui: {
      notify() {},
      setStatus() {},
      setWidget(_key: string, lines: any) {
        widgets.push(lines);
      },
    },
  };

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        toolCount: 2,
        progress: [{
          agent: "code-reviewer",
          status: "running",
          currentTool: "read",
          currentToolArgs: "src/index.ts",
          toolCount: 2,
          tokens: 1200,
          durationMs: 1500,
          recentOutput: ["found issue in parser"],
          recentTools: [{ tool: "read", args: "src/index.ts" }],
        }],
      });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: { content: [{ type: "text", text: "ok" }], details: { results: [] } },
      });
    }, 0);
  });

  await runWorkflow(
    pi as any,
    ctx as any,
    { name: "widget-test", sourcePath: "widget-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
    "",
  );

  const renderedWidgets = widgets.map((widget) => {
    if (typeof widget === "function") return widget(null, testTheme).render(120);
    return widget;
  });
  const detailedWidget = renderedWidgets.find((lines) => Array.isArray(lines) && lines.some((line: string) => line.includes("found issue in parser")));
  assert.ok(detailedWidget);
  assert.match(detailedWidget.join("\n"), /read: src\/index\.ts/);
  assert.doesNotMatch(detailedWidget.join("\n"), /Ctrl\+O details/);
});

test("workflow message renderers expose live progress and expanded agent details", async () => {
  const events = createEvents();
  const messages: any[] = [];
  const renderers = new Map<string, any>();
  const progressComponents: any[] = [];
  const longBashCommand = `node scripts/check-rendering.js ${"--flag ".repeat(30)}--important-tail-token`;
  const synthesizedReview = [
    "## Summary",
    "synthesized final review",
    ...Array.from({ length: 34 }, (_, index) => `- synthesized line ${index + 1}`),
  ].join("\n");
  const reviewerNotes = [
    "### Reviewer Markdown",
    "- reviewer bullet 1",
    ...Array.from({ length: 12 }, (_, index) => `- unique reviewer line ${index + 1}`),
  ].join("\n");
  const pi = {
    events,
    sendMessage(message: any) {
      messages.push(message);
      if (message.customType === "pi-workflows-progress") {
        const renderer = renderers.get("pi-workflows-progress");
        if (renderer) progressComponents.push(renderer(message, { expanded: true }));
      }
    },
    registerCommand() {},
    on() {},
    registerMessageRenderer(type: string, renderer: any) {
      renderers.set(type, renderer);
    },
  };

  registerPiWorkflows(pi as any);

  events.on(REQUEST_EVENT, (data) => {
    const request = data as { requestId: string };
    setTimeout(() => {
      events.emit(STARTED_EVENT, { requestId: request.requestId });
      events.emit("subagent:slash:update", {
        requestId: request.requestId,
        toolCount: 2,
        progress: [{
          agent: "code-reviewer",
          status: "running",
          currentTool: "read",
          currentToolArgs: "src/index.ts",
          toolCount: 2,
          tokens: 1200,
          durationMs: 1500,
          recentOutput: ["found issue in parser"],
          recentTools: [{ tool: "read", args: "src/index.ts" }],
        }],
      });
      events.emit(RESPONSE_EVENT, {
        requestId: request.requestId,
        isError: false,
        result: {
          content: [{ type: "text", text: synthesizedReview }],
          details: {
            progress: [{
              agent: "code-reviewer",
              status: "completed",
              currentTool: "read",
              currentToolArgs: "src/index.ts",
              toolCount: 3,
              tokens: 1800,
              durationMs: 2500,
              recentOutput: ["terminal progress completed"],
              recentTools: [{ tool: "read", args: "src/index.ts" }, { tool: "bash", args: longBashCommand }],
            }],
            results: [{
              agent: "code-reviewer",
              exitCode: 0,
              finalOutput: reviewerNotes,
              sessionFile: "/tmp/child-session.jsonl",
              savedOutputPath: "/tmp/saved-review.md",
              artifactPaths: {
                inputPath: "/tmp/reviewer-input.json",
                outputPath: "/tmp/reviewer-output.md",
                jsonlPath: "/tmp/reviewer-events.jsonl",
                metadataPath: "/tmp/reviewer-metadata.json",
              },
            }, {
              agent: "review-synthesizer",
              exitCode: 0,
              finalOutput: synthesizedReview,
            }],
          },
        },
      });
    }, 0);
  });

  await runWorkflow(
    pi as any,
    createCtx() as any,
    { name: "render-test", sourcePath: "render-test.jsonc", agent: "a", task: "t", modelPolicy: "agent" } as any,
    "",
  );

  const progressRenderer = renderers.get("pi-workflows-progress");
  const resultRenderer = renderers.get("pi-workflows-result");
  assert.ok(progressRenderer);
  assert.ok(resultRenderer);

  const progressMessage = messages.find((message) => message.customType === "pi-workflows-progress");
  const progressLines = progressRenderer(progressMessage, { expanded: true }).render(120).join("\n");
  assert.match(progressLines, /workflow \/render-test/);
  assert.match(progressLines, /✓ code-reviewer: completed/);
  assert.match(progressLines, /read: src\/index\.ts/);
  assert.match(progressLines, /terminal progress completed/);
  assert.match(progressLines, /important-tail-token/);
  assert.doesNotMatch(progressLines, /code-reviewer: running/);
  assert.equal(progressComponents.length, 1);
  const liveComponentLines = progressComponents[0].render(120).join("\n");
  assert.match(liveComponentLines, /✓ code-reviewer: completed/);
  assert.match(liveComponentLines, /terminal progress completed/);

  const resultMessage = messages.find((message) => message.customType === "pi-workflows-result");
  const collapsedLines = resultRenderer(resultMessage, { expanded: false }).render(120).join("\n");
  assert.match(collapsedLines, /synthesized final review/);
  assert.match(collapsedLines, /synthesized line 34/);
  assert.match(collapsedLines, /Ctrl\+O for 2 agent details/);
  assert.doesNotMatch(collapsedLines, /Agent details/);
  assert.doesNotMatch(collapsedLines, /Reviewer Markdown/);
  const narrowCollapsedLines = resultRenderer(resultMessage, { expanded: false }).render(48).join("\n");
  assert.match(narrowCollapsedLines, /synthesized line 34/);
  assert.doesNotMatch(narrowCollapsedLines, /more visual lines/);
  const rerenderedCollapsedLines = resultRenderer(resultMessage, { expanded: false }).render(120).join("\n");
  assert.match(rerenderedCollapsedLines, /synthesized line 34/);
  const expandedLines = resultRenderer(resultMessage, { expanded: true }).render(120).join("\n");
  assert.match(expandedLines, /Agent details/);
  assert.match(expandedLines, /synthesized line 34/);
  assert.match(expandedLines, /Reviewer Markdown/);
  assert.match(expandedLines, /unique reviewer line 12/);
  assert.match(expandedLines, /session: \/tmp\/child-session\.jsonl/);
  assert.match(expandedLines, /saved output: \/tmp\/saved-review\.md/);
  assert.match(expandedLines, /artifact input: \/tmp\/reviewer-input\.json/);
  assert.match(expandedLines, /artifact output: \/tmp\/reviewer-output\.md/);
  assert.match(expandedLines, /artifact jsonl: \/tmp\/reviewer-events\.jsonl/);
  assert.match(expandedLines, /artifact metadata: \/tmp\/reviewer-metadata\.json/);
  assert.match(expandedLines, /✓ code-reviewer: completed/);
  assert.doesNotMatch(expandedLines, /code-reviewer: running/);
});

test("session cwd discovery does not register repo-local direct commands", () => withTempHome((home) => {
  const globalDir = join(home, ".pi", "agent", "workflows");
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, "global.jsonc"), `{ "name": "global-direct-test", "description": "global", "agent": "a", "task": "t" }`);

  const repoA = mkdtempSync(join(tmpdir(), "pi-workflows-cwd-a-"));
  const repoAWorkflowDir = join(repoA, ".pi", "workflows");
  mkdirSync(repoAWorkflowDir, { recursive: true });
  writeFileSync(join(repoAWorkflowDir, "local.jsonc"), `{ "name": "repo-only-test", "description": "local", "agent": "a", "task": "t" }`);

  const repoB = mkdtempSync(join(tmpdir(), "pi-workflows-cwd-b-"));
  const commands = new Map<string, any>();
  const events = new Map<string, (...args: any[]) => void>();
  const pi = {
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on(event: string, handler: (...args: any[]) => void) {
      events.set(event, handler);
    },
  };

  registerPiWorkflows(pi as any);
  assert.ok(commands.has("global-direct-test"));

  events.get("session_start")?.({}, createCtx(repoA));
  assert.equal(commands.has("repo-only-test"), false);
  const completions = commands.get("workflow").getArgumentCompletions("repo");
  assert.ok(completions.some((completion: any) => completion.value === "repo-only-test"));

  events.get("session_start")?.({}, createCtx(repoB));
  assert.equal(commands.has("repo-only-test"), false);
}));
