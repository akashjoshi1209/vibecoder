// The locked tool contract (TOOL_SCHEMA_VERSION).
//
// Every tool — built-in, plugin, or proxied from MCP — goes through
// registerTool(), which runs validateTool() from this file. That single choke
// point is what "locking" means here: a name that is not a lowercase
// identifier, a missing description, or inputs that are not a JSON-schema
// object are refused at registration, not discovered mid-run by the provider.
//
// The contract, version 1:
//   - name:          /^[a-z][a-z0-9_]{0,63}$/ — also the MCP and JSON-RPC name
//   - inputs:        definition.function.parameters — a JSON schema of type
//                    "object" (properties are schemas themselves)
//   - output:        run() resolves a string. Success is the content; a failure
//                    starts with "ERROR: "; a policy refusal starts with
//                    "BLOCKED". The loop's trace and cost accounting read that
//                    prefix, so tool authors should keep it.
//   - cost/trace:    optional `cost` metadata (declared, machine-readable cost
//                    hints) and an `onTrace` hook the host calls after every
//                    execution with { tool, args, ms, ok } so a tool can
//                    attribute cost or append domain context.
import type { ToolDefinition } from "../llm/types";

/** Bump only on breaking changes to the shape below; plugins built against a
 *  version declare it in their `vibecoder.extension` entry. */
export const TOOL_SCHEMA_VERSION = 1;

/** The only legal tool name shape. Lowercase so the name survives shell,
 *  MCP, and JSON-RPC round-trips unchanged. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Declared, machine-readable cost hints (the "cost hook"). The host may use
 *  these for scheduling and reporting; they never affect correctness. */
export interface ToolCostMeta {
  /** Nominal wall-clock cost of one call, in milliseconds. */
  typicalMs?: number;
  /** May spend real resources: model tokens, network quota, installs. */
  expensive?: boolean;
}

/** What the host passes to `onTrace` after every execution (the "trace hook"). */
export interface ToolTraceEvent {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  /** False when the result was an ERROR/BLOCKED string or the run threw. */
  ok: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateJsonSchemaValue(schema: unknown, where: string, errors: string[]): void {
  if (!isPlainObject(schema)) {
    errors.push(`${where} must be a JSON-schema object`);
    return;
  }
  const t = schema.type;
  if (t !== undefined && typeof t !== "string" && !(Array.isArray(t) && t.every((x) => typeof x === "string"))) {
    errors.push(`${where}.type must be a string or string array`);
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    errors.push(`${where}.properties must be an object`);
  }
  if (schema.items !== undefined) validateJsonSchemaValue(schema.items, `${where}.items`, errors);
}

/**
 * Validate a tool against the locked schema. Returns human-readable errors
 * (empty when the tool conforms). Structural checks only — rules whose
 * violation would crash a run or confuse a provider, not taste.
 */
export function validateTool(tool: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(tool)) return ["tool must be an object { definition, run }"];
  if (typeof tool.run !== "function") errors.push("tool.run must be a function (args, ctx) => Promise<string>");
  const def = tool.definition as unknown;
  if (!isPlainObject(def)) {
    errors.push("tool.definition must be a function-call definition object");
    return errors;
  }
  if (def.type !== "function") errors.push('definition.type must be "function"');
  const fn = def.function;
  if (!isPlainObject(fn)) {
    errors.push("definition.function must be an object");
    return errors;
  }
  if (typeof fn.name !== "string" || !TOOL_NAME_RE.test(fn.name)) {
    errors.push(
      `tool name ${JSON.stringify(fn.name)} must match ${String(TOOL_NAME_RE)} (lowercase letters, digits, underscores; must start with a letter; max 64)`,
    );
  }
  if (typeof fn.description !== "string" || !fn.description.trim()) {
    errors.push(`tool ${JSON.stringify(fn.name)} needs a non-empty description — it is how the model knows when to call it`);
  }
  const params = fn.parameters as unknown;
  if (!isPlainObject(params)) {
    errors.push(`tool ${JSON.stringify(fn.name)}: definition.function.parameters must be a JSON-schema object`);
  } else {
    if (params.type !== "object") {
      errors.push(`tool ${JSON.stringify(fn.name)}: parameters.type must be "object" (tool arguments are an object)`);
    }
    if (params.properties !== undefined) {
      if (!isPlainObject(params.properties)) {
        errors.push(`tool ${JSON.stringify(fn.name)}: parameters.properties must be an object`);
      } else {
        for (const [key, prop] of Object.entries(params.properties)) {
          validateJsonSchemaValue(prop, `tool ${JSON.stringify(fn.name)}: parameters.properties.${key}`, errors);
        }
      }
    }
  }
  if (tool.cost !== undefined && !isPlainObject(tool.cost)) errors.push(`tool ${JSON.stringify(fn.name)}: cost must be an object ({ typicalMs?, expensive? })`);
  if (tool.onTrace !== undefined && typeof tool.onTrace !== "function") errors.push(`tool ${JSON.stringify(fn.name)}: onTrace must be a function when set`);
  return errors;
}
