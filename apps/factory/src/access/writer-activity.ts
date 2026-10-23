export const writerIdleMilliseconds = 5 * 60_000;
type Activity = {
  userID: string;
  epoch: string;
  observed: number;
  edited: number | null;
  seen: number | null;
  touched: number;
};

/** Ephemeral display/courtesy signals. Never a lease or a writing grant. */
export class WriterActivity {
  readonly #items = new Map<string, Activity>();
  #swept = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}

  #entry(changeID: string, userID: string, epoch: string) {
    const now = this.now();
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      for (const [id, item] of this.#items)
        if (now - item.touched > 24 * 60 * 60_000) this.#items.delete(id);
    }
    let entry = this.#items.get(changeID);
    if (!entry || entry.userID !== userID || entry.epoch !== epoch) {
      entry = { userID, epoch, observed: now, edited: null, seen: null, touched: now };
      this.#items.set(changeID, entry);
    } else entry.touched = now;
    return entry;
  }

  observe(changeID: string, userID: string, epoch: string, kind: "edit" | "heartbeat") {
    const entry = this.#entry(changeID, userID, epoch);
    entry.touched = this.now();
    entry.seen = entry.touched;
    if (kind === "edit") entry.edited = entry.touched;
  }

  snapshot(changeID: string, userID: string, epoch: string) {
    const entry = this.#entry(changeID, userID, epoch);
    const elapsed = Math.max(0, this.now() - (entry.edited ?? entry.observed));
    return {
      idle: elapsed >= writerIdleMilliseconds,
      secondsSinceEdit: entry.edited === null ? null : Math.floor(elapsed / 1000),
      connected: entry.seen !== null && this.now() - entry.seen < 45_000,
    };
  }

  clear(changeID: string) {
    this.#items.delete(changeID);
  }
}

export const writerActivity = new WriterActivity();
