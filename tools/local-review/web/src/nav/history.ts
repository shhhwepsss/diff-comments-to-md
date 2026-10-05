// Back / Forward for code navigation (← → in the file header, Alt+←/→).
//
// There is one history, the browser's: every jump — a file opened from the
// tree, a «go to definition» — is a pushState of the address that shows it
// (lib/hash.ts, with `file` and `line`), and ← → are history.back() /
// forward(). The review's popstate handler opens whatever the address names,
// so the buttons, the browser's own buttons and the mouse's side buttons all
// agree.
//
// What the browser does not tell a page is whether there is anything to go
// back or forward *to* inside the review. So each entry the review pushes
// carries its position in `history.state` (rvNav: 1, 2, …; the entry the
// review opened on is 0), and the furthest position
// reached is remembered per tab. ← is enabled above 0, → below that furthest
// one.
//
// An entry with no position at all is one nobody stamped yet: the review was
// opened on it, or the address was changed by hand, or the app came back
// from the settings page. Either way the browser just created it, and that
// dropped whatever was ahead — so the remembered furthest position is stale
// and the entry gets stamped with where it really is.

export type HistoryLike = {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
  back(): void;
  forward(): void;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type NavSnapshot = { canBack: boolean; canForward: boolean };

const FIELD = 'rvNav';

/** The position an entry's state records; 0 for an entry the review did not push. */
export function navIndexOf(state: unknown): number {
  const value = state && typeof state === 'object' ? (state as Record<string, unknown>)[FIELD] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Whether the review has stamped this entry with a position (0 included). */
export function hasNavIndex(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && FIELD in (state as Record<string, unknown>));
}

/** `state` with its position set; whatever else is in it (another library's data) is kept. */
export function withNavIndex(state: unknown, index: number): Record<string, unknown> {
  const base = state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
  return { ...base, [FIELD]: index };
}

export function snapshotOf(index: number, top: number): NavSnapshot {
  return { canBack: index > 0, canForward: index < top };
}

/**
 * The review's view of the browser history. `scope` names the review (its
 * route), so a furthest position remembered for one review does not enable
 * → in another.
 */
export class NavHistory {
  private index: number;
  private top: number;
  private snapshot: NavSnapshot;
  private listeners = new Set<() => void>();

  constructor(
    private readonly history: HistoryLike,
    private readonly storage: StorageLike | null,
    private readonly scope: string,
  ) {
    if (hasNavIndex(history.state)) {
      // A reload or a return to an entry seen before: what was ahead is still there.
      this.index = navIndexOf(history.state);
      this.top = Math.max(this.index, this.readTop());
    } else {
      this.index = 0;
      this.top = 0;
      this.stamp();
      this.writeTop();
    }
    this.snapshot = snapshotOf(this.index, this.top);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): NavSnapshot => this.snapshot;

  /** A new step: everything that was ahead of the current entry is gone, as in the browser. */
  push(hash: string) {
    this.index += 1;
    this.top = this.index;
    this.history.pushState(withNavIndex(this.history.state, this.index), '', hash);
    this.writeTop();
    this.publish();
  }

  /** The current entry, re-addressed (the line a jump starts from); its position stays. */
  replace(hash: string) {
    this.history.replaceState(withNavIndex(this.history.state, this.index), '', hash);
  }

  /** After popstate: the browser moved, read where to. */
  sync() {
    if (!hasNavIndex(this.history.state)) {
      // An address typed by hand: a new entry right after the one we were on.
      this.index += 1;
      this.top = this.index;
      this.stamp();
      this.writeTop();
    } else {
      this.index = navIndexOf(this.history.state);
      if (this.index > this.top) {
        this.top = this.index;
        this.writeTop();
      }
    }
    this.publish();
  }

  /** False when there is nothing behind inside the review: the key is then left to the browser. */
  back(): boolean {
    if (!this.snapshot.canBack) return false;
    this.history.back();
    return true;
  }

  forward(): boolean {
    if (!this.snapshot.canForward) return false;
    this.history.forward();
    return true;
  }

  private stamp() {
    this.history.replaceState(withNavIndex(this.history.state, this.index), '', null);
  }

  private publish() {
    const next = snapshotOf(this.index, this.top);
    if (next.canBack === this.snapshot.canBack && next.canForward === this.snapshot.canForward) return;
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private key() {
    return `rv-nav-top:${this.scope}`;
  }

  private readTop(): number {
    try {
      const n = Number(this.storage?.getItem(this.key()));
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private writeTop() {
    try {
      this.storage?.setItem(this.key(), String(this.top));
    } catch {
      /* private mode: → just forgets the furthest step after a reload */
    }
  }
}
