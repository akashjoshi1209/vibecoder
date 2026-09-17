import { ansi, fg } from "../terminal";

/**
 * Theme tokens — presentation-only.
 *
 * Maps every visual role to the 8-color primitives already exposed by
 * terminal.ts (`ansi` table + `fg(n)`). This layer must not invent new escape
 * codes: if a token is not expressible via ansi/fg it is intentionally absent.
 * 8-color, Termux-safe, no truecolor, no heavy palette.
 */
export const theme = {
  /** Wordmark + primary interactive accent. */
  accent: fg(36), // cyan
  /** Secondary accent — route/violet-ish for emphasis. */
  violet: fg(35), // magenta
  /** Tertiary accent — links / deep highlights. */
  deep: fg(34), // blue
  /** Success / completion. */
  success: fg(32), // green
  /** Warning / pending approval. */
  warm: fg(33), // yellow
  /** Error / abort. */
  error: fg(31), // red
  /** Muted helper text. */
  muted: fg(90), // bright black (gray)
  reset: ansi.reset,
  bold: ansi.bold,
  dim: ansi.dim,
} as const;

export type Theme = typeof theme;

/** Map a named role to its theme token, falling back to theme.reset if unknown. */
export function token(role: keyof Theme | string): string {
  return (theme as Record<string, string>)[role] ?? theme.reset;
}
