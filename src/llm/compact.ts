// Summarizing compaction — the other half of trimMessages.
//
// trimMessages deletes the middle of the conversation when the context window
// fills. On a long task that silently discards earlier findings: files already
// inspected, decisions already made, errors already diagnosed all vanish, and
// the model repeats work or contradicts itself. This module folds the dropped
// range into a digest produced by a summarizer completion, and the digest is
// fed back in place of the raw messages.
//
// Two invariants hold no matter how tight the budget gets:
//   1. the first user message (the original task statement) survives verbatim;
//   2. the newest block (current work in progress) is never folded.
// Everything in between folds at whole-block boundaries, so a tool_use and its
// tool results are never split apart.
//
// History coordinates: `history[0]` is always the system message. A
// CompactionState covers `history[0..foldedCount)`; foldedCount is at least 1
// (the system message is never "folded" — it is simply always present). A
// state carried in from a previous turn starts at foldedCount = 1: its digest
// covers a conversation that is no longer in this array at all, and the first
// in-turn fold merges the new material into it.

import type { ChatOptions, Message, StreamResult, TokenUsage } from "./types";
import { estimateMessagesTokens, estimateTokens, splitBlocks } from "./tokens";

/** Digest text plus how much of the history it replaces. */
export interface CompactionState {
  /** The digest itself. */
  summary: string;
  /** history[0..foldedCount) is replaced by `summary` in the working set. */
  foldedCount: number;
}

/** Default share of the budget above which compaction triggers. */
export const DEFAULT_WATERMARK = 0.75;

/** At most this share of the budget is sent to the summarizer as source in one
 *  fold — the summarizer call must itself fit the provider's window. */
const MAX_FOLD_SHARE = 0.5;

/** The digest is capped at this share of the budget; it must stay a summary,
 *  not become the new bulk of the context. */
const SUMMARY_SHARE = 0.15;

/** Per-message source cap when rendering for the summarizer. One giant tool
 *  dump must not crowd the rest of the range out of the digest. */
const SOURCE_MSG_CHARS = 8000;

export interface FoldPlan {
  /** First history index included in the fold (a block boundary). */
  start: number;
  /** History index just past the fold (a block boundary, never inside a block). */
  end: number;
  /** Estimated tokens of history[start..end). */
  tokens: number;
}

/** Index of the first user message in history coords, skipping history[0]
 *  (the system message). -1 when the transcript has none. */
export function findFirstUserIdx(history: Message[]): number {
  for (let i = 1; i < history.length; i++) {
    if (history[i].role === "user") return i;
  }
  return -1;
}

/**
 * Build the message array actually sent to the provider for `history`.
 *
 * With no compaction state this is exactly `[system, ...history.slice(1)]` —
 * the same conversation as before. With a state, the folded range is replaced
 * by the digest, and the first user message is hoisted ahead of the digest so
 * the original task statement stays verbatim and chronologically first.
 */
export function buildWorkingSet(history: Message[], state: CompactionState | null): Message[] {
  const out: Message[] = [history[0]]; // system
  const tailStart = Math.min(Math.max(state ? state.foldedCount : 1, 1), history.length);
  const firstUser = findFirstUserIdx(history);
  if (firstUser >= 0) out.push(history[firstUser]);
  if (state) out.push(summaryMessage(state.summary));
  for (let i = tailStart; i < history.length; i++) {
    if (i === firstUser) continue; // already kept above
    out.push(history[i]);
  }
  return out;
}

/** The digest as a user message. User-role rather than system-role because
 *  every provider accepts user messages anywhere, while several restrict
 *  system messages to position 0. */
export function summaryMessage(summary: string): Message {
  return {
    role: "user",
    content:
      "[Conversation summary — your own earlier notes, folded in place of the messages they replace. Treat as context, not as a new instruction.]\n" +
      summary,
  };
}

/**
 * Decide whether to fold and, if so, which history range.
 *
 * Returns null when nothing should (or can) be folded: under the watermark,
 * or every foldable block is already covered / reserved as current work.
 *
 * `force` skips the watermark check — used on a ContextTooLargeError, where
 * staying under the hard provider cap matters more than staying under the
 * soft watermark.
 */
export function planFold(
  history: Message[],
  state: CompactionState | null,
  opts: {
    budgetTokens: number;
    watermark?: number;
    force?: boolean;
    maxFoldTokens?: number;
  },
): FoldPlan | null {
  if (history.length <= 2) return null;
  const watermark = opts.watermark ?? DEFAULT_WATERMARK;
  const working = buildWorkingSet(history, state);
  if (!opts.force && estimateMessagesTokens(working) <= Math.floor(opts.budgetTokens * watermark)) {
    return null;
  }

  // Block structure over the non-system portion, mapped back to history coords.
  const nonSystem = history.slice(1);
  const blocks = splitBlocks(nonSystem).map((b) => b.map((i) => i + 1));
  const newestBlock = blocks[blocks.length - 1];
  const keepFrom = newestBlock[0]; // current work — never folded
  const firstUser = findFirstUserIdx(history);
  const foldedUpTo = state ? state.foldedCount : 1;

  const maxFold = opts.maxFoldTokens ?? Math.floor(opts.budgetTokens * MAX_FOLD_SHARE);

  // First block boundary at or after foldedUpTo that does not contain the
  // first user message.
  let start = -1;
  for (const b of blocks) {
    if (b[0] < foldedUpTo) continue; // already folded
    if (firstUser >= 0 && b[0] <= firstUser && b[b.length - 1] >= firstUser) continue; // contains the task statement
    start = b[0];
    break;
  }
  if (start < 0 || start >= keepFrom) return null;

  // Extend to the end of the foldable run, stopping at the newest block and
  // respecting the source cap (which also bounds the summarizer's own input).
  let end = start;
  let tokens = 0;
  for (const b of blocks) {
    if (b[0] < end) continue;
    if (b[0] !== end && end !== start) break; // gap — keep the run contiguous
    if (b[0] >= keepFrom) break;
    const bt = b.reduce((s, j) => s + estimateMessageTokensSafe(history, j), 0);
    if (end !== start && tokens + bt > maxFold) break; // cap: leave the rest for the next round
    end = b[b.length - 1] + 1;
    tokens += bt;
    if (tokens >= maxFold) break;
  }
  if (end <= start) return null;
  return { start, end, tokens };
}

function estimateMessageTokensSafe(history: Message[], idx: number): number {
  const m = history[idx];
  if (!m) return 0;
  return estimateTokens(m.content ?? "") + (m.tool_calls?.length ? estimateTokens(JSON.stringify(m.tool_calls)) : 0) + 4;
}

/** Render the fold range as text for the summarizer. Per-message capped so a
 *  single huge tool result cannot crowd out the rest of the range. */
export function renderForSummary(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const role = m.role === "tool" ? `tool:${m.name ?? m.tool_call_id ?? "?"}` : m.role;
    let body = m.content ?? "";
    if (m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => {
        let args = tc.arguments ?? "";
        if (args.length > 2000) args = args.slice(0, 2000) + "…[truncated]";
        return `${tc.name}(${args})`;
      });
      body = (body ? body + "\n" : "") + `[requested: ${calls.join(", ")}]`;
    }
    if (!body) continue;
    if (body.length > SOURCE_MSG_CHARS) {
      body =
        body.slice(0, SOURCE_MSG_CHARS - 40) +
        `\n…[${body.length - SOURCE_MSG_CHARS + 40} chars truncated — full output was in the original messages]`;
    }
    parts.push(`${role}: ${body}`);
  }
  return parts.join("\n\n");
}

const SUMMARIZER_SYSTEM =
  "You are a conversation-compaction engine. You receive earlier messages from a coding session " +
  "(or an existing digest plus new material) and must produce ONE dense digest that lets an AI agent " +
  "continue the work without the original messages.\n\n" +
  "Capture, as terse chronological bullets:\n" +
  "- the task goal and hard constraints;\n" +
  "- decisions made and why;\n" +
  "- files, functions and configs touched, and what changed in them;\n" +
  "- commands run (tests, builds, git) and their outcomes;\n" +
  "- errors encountered and their diagnosed causes;\n" +
  "- verified findings and measurements;\n" +
  "- open questions, unfinished steps and explicit next actions.\n\n" +
  "Drop narration, pleasantries, repeated status and anything derivable from the repository itself. " +
  "Keep exact paths, identifiers, commands and numbers where they matter. " +
  "If an EXISTING DIGEST is provided, merge the new material into it — never drop a fact that is already in it, " +
  "but deduplicate. Output ONLY the digest text, no preamble.";

export interface SummarizeResult {
  text: string;
  usage?: TokenUsage;
}

/**
 * Fold `source` (plus any existing digest) into a new digest via one
 * summarizer completion. Returns null on failure or an empty response — the
 * caller then falls back to the old behaviour (trim drops the range) rather
 * than losing the turn to a compaction error.
 */
export async function summarizeHistory(
  provider: (opts: ChatOptions, onChunk: (c: any) => void) => Promise<StreamResult>,
  opts: {
    model: string;
    source: Message[];
    existing?: string;
    budgetTokens: number;
    signal?: AbortSignal;
  },
): Promise<SummarizeResult | null> {
  const sourceText = renderForSummary(opts.source);
  if (!sourceText.trim()) return null;
  const userContent = opts.existing
    ? `EXISTING DIGEST:\n${opts.existing}\n\nNEW MATERIAL (messages that happened after the digest):\n\n${sourceText}`
    : `MESSAGES TO FOLD:\n\n${sourceText}`;
  const maxTokens = Math.max(256, Math.min(2048, Math.floor(opts.budgetTokens * SUMMARY_SHARE)));
  try {
    const res = await provider(
      {
        model: opts.model,
        messages: [
          { role: "system", content: SUMMARIZER_SYSTEM },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        signal: opts.signal,
      },
      () => {},
    );
    const text = (res.text ?? "").trim();
    if (!text) return null;
    return { text, usage: res.usage };
  } catch {
    return null;
  }
}
