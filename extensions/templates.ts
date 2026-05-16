import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function splitArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaped = false;
  let tokenStarted = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        result.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (escaped) current += "\\";
  if (tokenStarted) result.push(current);
  return result;
}

export function runtimeArgs(rawArgs: string) {
  return { args: rawArgs, positional: splitArgs(rawArgs) };
}

export function renderTemplate(
  value: string,
  rawArgs: string,
  ctx: ExtensionCommandContext,
  positional = splitArgs(rawArgs),
): string {
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "args" || key === "$@") return rawArgs;
    if (key === "cwd") return ctx.cwd;
    if (key === "previous") return "{previous}";
    if (key === "task") return "{task}";
    if (key === "chain_dir" || key === "chainDir") return "{chain_dir}";
    if (/^\d+$/.test(key)) return positional[Number(key) - 1] ?? "";
    return match;
  });
}

export function renderCompositeTemplate(
  value: string,
  rawArgs: string,
  ctx: ExtensionCommandContext,
  positional = splitArgs(rawArgs),
  previous = "",
  task = rawArgs,
): string {
  return value.replace(/{{\s*([^}]+?)\s*}}/g, (match, rawKey: string) => {
    const key = rawKey.trim();
    if (key === "args" || key === "$@") return rawArgs;
    if (key === "cwd") return ctx.cwd;
    if (key === "previous") return previous;
    if (key === "task") return task;
    if (key === "chain_dir" || key === "chainDir") return "{chain_dir}";
    if (/^\d+$/.test(key)) return positional[Number(key) - 1] ?? "";
    return match;
  });
}
