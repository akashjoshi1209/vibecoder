import type { Message } from "./types";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative per-character-class weights, calibrated against GROQ's real
  // tokenizer (prompt_tokens): CJK ~1 char/token, digits/letters ~4/token,
  // punctuation/symbols ~1.8/token, whitespace negligible. When in doubt we
  // over-count so trimmed requests stay under the provider's hard input cap.
  let t = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) t += 1;
    else if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) t += 0.5;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) t += 0.25;
    else t += 0.55;
  }
  return Math.ceil(t) + 1;
}

const MSG_OVERHEAD = 4;

export function estimateMessageTokens(m: Message): number {
  let total = MSG_OVERHEAD;
  if (m.content) total += estimateTokens(m.content);
  if (m.tool_calls && m.tool_calls.length) total += estimateTokens(JSON.stringify(m.tool_calls));
  return total;
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((s, m) => s + estimateMessageTokens(m), 0);
}

export interface TrimOptions {
  // Total budget for system + kept messages (+ tools handled via reservedTokens).
  budgetTokens: number;
  // Tokens the caller knows are sent outside the messages array (tool schemas, etc).
  reservedTokens?: number;
  // Hard floor: at least the newest message is kept even when nothing fits.
  keepNewest?: boolean;
}

export interface TrimResult {
  messages: Message[];
  trimmed: number;
  truncatedChars: number;
}

function cloneMessage(m: Message): Message {
  return {
    ...m,
    content: m.content,
    tool_calls: m.tool_calls ? m.tool_calls.map((tc) => ({ ...tc })) : undefined,
  };
}

// Atomic blocks: a tool-use assistant message plus the tool results that answer
// it must stay together, or the provider rejects the sequence (tool_use_failed).
function splitBlocks(nonSystem: Message[]): number[][] {
  const blocks: number[][] = [];
  let i = 0;
  while (i < nonSystem.length) {
    const m = nonSystem[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length) {
      const b = [i];
      i++;
      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        b.push(i);
        i++;
      }
      blocks.push(b);
    } else if (m.role === "tool") {
      // Orphan tool result with no preceding tool_use in this conversation —
      // treat it as its own block so it can be trimmed independently.
      const b = [i];
      i++;
      while (i < nonSystem.length && nonSystem[i].role === "tool") {
        b.push(i);
        i++;
      }
      blocks.push(b);
    } else {
      blocks.push([i]);
      i++;
    }
  }
  return blocks;
}

export function trimMessages(messages: Message[], opts: TrimOptions): TrimResult {
  if (!messages.length) return { messages, trimmed: 0, truncatedChars: 0 };
  const budget = opts.budgetTokens - (opts.reservedTokens ?? 0);
  const system: Message[] = [];
  const nonSystem: Message[] = [];
  for (const m of messages) (m.role === "system" ? system : nonSystem).push(m);

  const blockTokens = (idx: number): number =>
    blocks[idx].reduce((s, j) => s + estimateMessageTokens(nonSystem[j]), 0);

  const blocks = splitBlocks(nonSystem);

  // Nothing but system messages (or empty): nothing to trim.
  if (!blocks.length) {
    return { messages: system.map(cloneMessage), trimmed: messages.length - system.length, truncatedChars: 0 };
  }

  if (budget < 1) {
    const lastIdx = blocks[blocks.length - 1];
    const kept = lastIdx.map((j) => cloneMessage(nonSystem[j]));
    return { messages: [...system.map(cloneMessage), ...kept], trimmed: messages.length - (system.length + kept.length), truncatedChars: 0 };
  }

  let used = system.reduce((s, m) => s + estimateMessageTokens(m), 0);

  // Always keep the newest block (current work) and the first user block (the
  // original task statement), when they exist.
  const firstUserBlock = blocks.findIndex((b) => nonSystem[b[0]].role === "user");
  const newestBlock = blocks.length - 1;
  const keepBlock = new Set<number>([newestBlock]);
  if (firstUserBlock >= 0 && firstUserBlock !== newestBlock) keepBlock.add(firstUserBlock);
  for (const bi of keepBlock) used += blockTokens(bi);

  // Fill from newest backwards with whole blocks that still fit.
  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    if (keepBlock.has(bi)) continue;
    const bt = blockTokens(bi);
    if (used + bt > budget) continue;
    keepBlock.add(bi);
    used += bt;
  }

  const kept: Message[] = system.map(cloneMessage);
  for (let bi = 0; bi < blocks.length; bi++) {
    if (!keepBlock.has(bi)) continue;
    for (const j of blocks[bi]) kept.push(cloneMessage(nonSystem[j]));
  }

  const truncatedChars = truncateToFit(kept, budget);

  return { messages: kept, trimmed: messages.length - kept.length, truncatedChars };
}

function truncateToFit(messages: Message[], budget: number): number {
  let used = estimateMessagesTokens(messages);
  if (used <= budget) return 0;
  let truncated = 0;
  // Pass 1: empty every non-system message except the newest, oldest first.
  // The system prompt and the current (latest) message keep their content.
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (m.role === "system" || !m.content) continue;
    truncated += m.content.length;
    m.content = "";
    used = estimateMessagesTokens(messages);
    if (used <= budget) return truncated;
  }
  // Pass 2: only the newest message moves the needle — shrink it into budget.
  const newest = messages[messages.length - 1];
  if (newest.content && used > budget) {
    const overflow = used - budget;
    const remove = Math.min(newest.content.length, Math.max(50, Math.ceil(overflow * 4)));
    if (remove > 0 && remove < newest.content.length) {
      newest.content = newest.content.slice(0, newest.content.length - remove) + "\n…[trimmed]";
      truncated += remove;
    }
  }
  return truncated;
}