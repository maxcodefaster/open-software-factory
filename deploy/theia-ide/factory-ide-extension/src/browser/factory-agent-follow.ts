/**
 * Decides when the editor may move to a file the agent just changed. The editor holds back
 * while the person is typing, scrolling or clicking, and catches up once they stop. Only the
 * newest target waits, so a burst of edits moves the editor once.
 */
export class AgentFollowGate<T> {
  #following = true;
  #pending: T | undefined;
  #lastInteraction = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly now: () => number,
    private readonly quietMs: number,
  ) {}

  get following() {
    return this.#following;
  }

  setFollowing(following: boolean) {
    this.#following = following;
    if (!following) this.#pending = undefined;
  }

  interact() {
    this.#lastInteraction = this.now();
  }

  offer(target: T) {
    if (this.#following) this.#pending = target;
  }

  /** Returns the waiting target once the person has been quiet long enough. */
  take(): T | undefined {
    if (!this.#following || this.#pending === undefined) return undefined;
    if (this.now() - this.#lastInteraction < this.quietMs) return undefined;
    const target = this.#pending;
    this.#pending = undefined;
    return target;
  }

  get waiting() {
    return this.#pending !== undefined;
  }
}
