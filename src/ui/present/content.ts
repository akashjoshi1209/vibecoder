/**
 * present/content.ts — the presentation **content model**.
 *
 * Producers emit `Content` values (semantic + lossless plain `text`); the
 * present layer decides how each is drawn. This module owns ONLY the model —
 * no terminal escapes, no geometry.
 */

/** Every content kind the presentation choke point can route. */
export type ContentType =
  | "plain" // always the root: plain text fallback
  | "table"
  | "chart"
  | "code"
  | "diff"
  | "image";

/** A single piece of presentable content. `text` is always lossless + plain. */
export interface Content {
  type: ContentType;
  /** Lossless canonical form — what a plain terminal renders. NEVER empty for payload-bearing content. */
  text: string;
  /** Rich-only structured data, optional; falls back to `text` in plain mode. */
  payload?: Record<string, unknown> | string[];
}

export function content(type: ContentType, text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type, text, payload };
}

export function plain(text: string): Content {
  return { type: "plain", text };
}

export function table(text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type: "table", text, payload };
}

export function chart(text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type: "chart", text, payload };
}

export function code(text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type: "code", text, payload };
}

export function diff(text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type: "diff", text, payload };
}

export function image(text: string, payload?: Record<string, unknown> | string[]): Content {
  return { type: "image", text, payload };
}
