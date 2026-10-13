/** Coalesce Project browsing into one source admission and one latest selection. */
export function selectedSourcePreparation(
  ensure: (projectID: string) => Promise<void>,
  delayMS = 750,
) {
  let selected: string | undefined;
  let pending: string | undefined;
  let running = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const drain = async () => {
    timer = undefined;
    if (running || closed || !pending) return;
    const projectID = pending;
    pending = undefined;
    running = true;
    try {
      // Admission is bounded by its caller. Cancelling a browser request cannot
      // undo persisted server intent, so never start competing admissions.
      await ensure(projectID);
    } catch {
      // Explicit IDE opening remains the visible, retryable command path.
    } finally {
      running = false;
      if (!closed && pending && pending === selected) schedule();
    }
  };
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void drain(), delayMS);
  };
  return {
    select(projectID: string | undefined) {
      if (closed || projectID === selected) return;
      selected = projectID;
      pending = projectID;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!running && pending) schedule();
    },
    close() {
      closed = true;
      pending = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
