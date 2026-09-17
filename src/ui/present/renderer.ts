import type { ContentType, Content } from "./content";
import { wrapAnsi, wrapText } from "../terminal";
import { theme } from "./theme";

/**
 * A renderer turns a `Content` into screen rows. It must NEVER emit a row wider
 * than `cols` and must NEVER emit raw binary. The contract is enforced by the
 * choke point (`present`), which clamps every row as a final gate.
 */
export interface Presenter {
  /** The content types this presenter can render richly. */
  readonly types: readonly ContentType[];
  /**
   * Render `c` into rows of at most `cols` display columns. Return `null` to
   * decline (caller falls back to the plain presenter).
   */
  render(c: Content, cols: number): string[] | null;
  /** Human label, used for selection/discovery only. */
  readonly name: string;
}

export interface PresenterMap {
  [type: string]: Presenter;
}

/** Registry choke point: map content type → its chosen presenter. */
export interface PresenterRegistry {
  get(type: ContentType): Presenter | undefined;
  register(p: Presenter): void;
  list(): Presenter[];
}

class Registry implements PresenterRegistry {
  private presenters: PresenterMap = {};

  register(p: Presenter): void {
    this.presenters[p.name] = p;
  }
  get(type: ContentType): Presenter | undefined {
    return this.presenters[type];
  }
  list(): Presenter[] {
    return Object.values(this.presenters);
  }
  reset(): void {
    this.presenters = {};
  }
}

export function createRegistry(): PresenterRegistry {
  return new Registry();
}
