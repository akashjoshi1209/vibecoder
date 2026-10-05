// ── hooks system ────────────────────────────────────────────────────────────────
// Hooks let modules inject behavior at key points in the agent lifecycle.
// Hooks are called in registration order. A hook may return a promise;
// the agent loop awaits it before continuing. Any hook may throw to abort.

export type HookContext = {
  cwd: string;
  messages: unknown[];
  toolCtx: Record<string, unknown>;
};

export type HookLifecycle =
  | { kind: "beforePrompt";    context: HookContext; userInput: string }
  | { kind: "afterTool";       context: HookContext; toolName: string; toolArgs: Record<string, unknown>; toolResult: string }
  | { kind: "afterStep";       context: HookContext; stepIndex: number; toolCallCount: number; maxSteps: number; accumulatedText: string }
  | { kind: "onFinish";        context: HookContext; finishReason: string; finalText: string; toolCallCount: number };

export type HookFn = (event: HookLifecycle) => void | Promise<void>;

const hooks: HookFn[] = [];

export function registerHook(fn: HookFn): void {
  hooks.push(fn);
}

export async function runHooks(event: HookLifecycle): Promise<void> {
  // HookFn may be sync or async, so wrap in Promise.resolve before catching:
  // calling .catch() directly on a void return threw TypeError.
  await Promise.all(
    hooks.map((fn) =>
      Promise.resolve(fn(event)).catch((err: unknown) => {
        // Hook errors are logged but don't abort the agent — a misbehaving hook
        // shouldn't break the whole run.
        process.stderr.write(`[vibecoder:hook error] ${err}\n`);
      }),
    ),
  );
}

export function clearHooks(): void {
  hooks.length = 0;
}
