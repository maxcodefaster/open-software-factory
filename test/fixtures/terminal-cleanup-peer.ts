// Controlled native HTTP responses only. This never runs an OpenCode server.
// The injected sequence is a hypothesis, not a reconstruction of the live turn.
export type CleanupScenario =
  | "cleanup-abort"
  | "unchanged-success"
  | "provider-error"
  | "pre-cleanup-abort"
  | "unknown-shell"
  | "new-input-before-cleanup"
  | "new-input-during-cleanup"
  | "queued-shell-notification";

type Transport = (request: Request, path: string) => Promise<Response>;
type Message = {
  id: string;
  type: string;
  time: { created: number; completed?: number };
  finish?: string;
  error?: unknown;
  content?: unknown[];
  text?: string;
  description?: string;
  metadata?: Record<string, unknown>;
};

export const interruptedStep = { type: "aborted", message: "Step interrupted" } as const;
export const providerError = {
  type: "provider.internal",
  message: "Owned provider failed before terminal cleanup",
} as const;

export function cleanupPeer(
  sessionID: string,
  scenario: CleanupScenario,
  next: Transport,
  notify: () => void,
) {
  const shellID = "sh_owned_terminal_cleanup";
  const assistantID = "msg_owned_cleanup_attempt";
  const newerInputID = "msg_owned_newer_input";
  const removalEntered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const trace: string[] = [];
  let enabled = true;
  let armed = false;
  let ready = false;
  let shell = true;
  let inference = true;
  let cleanupStep: Message | undefined;
  let notification: Message | undefined;
  let newerInput = false;
  let interrupts = 0;
  let removals = 0;
  let terminalHistoryReads = 0;
  let postCleanupHistoryReads = 0;
  let cancellations = 0;
  let queuedNotification = false;

  const transport: Transport = async (request, path) => {
    if (!enabled) return next(request, path);
    const url = new URL(request.url);
    if (url.pathname === "/api/session/active")
      return Response.json({
        data: armed && inference ? { [sessionID]: { type: "running" } } : {},
      });
    if (url.pathname === "/api/shell")
      return Response.json({
        data: !armed
          ? []
          : [
              ...(shell ? [{ id: shellID, status: "running", metadata: { sessionID } }] : []),
              ...(scenario === "unknown-shell"
                ? [{ id: "sh_unattributed_do_not_remove", status: "running", metadata: {} }]
                : []),
            ],
      });
    if (url.pathname === `/api/session/${sessionID}/interrupt` && request.method === "POST") {
      interrupts++;
      trace.push("root-interrupt");
      const active = inference;
      if (cleanupStep && !cleanupStep.time.completed) {
        // Published 2.0.27 Step.Failed projects onto this attempt's assistant ID.
        // It does not rewrite the prior, durably completed successful assistant.
        cleanupStep.time.completed = 5;
        cleanupStep.finish = "error";
        cleanupStep.error = interruptedStep;
        trace.push("session.step.failed:cleanup:aborted");
      }
      inference = false;
      notify();
      // The first idle interrupt returns false. The trailing interrupt catches
      // a synthetic execution started while the owned shell was being removed.
      return Response.json({ interrupted: active });
    }
    if (url.pathname === `/api/shell/${shellID}` && request.method === "DELETE") {
      removals++;
      trace.push("owned-shell-delete");
      if (!ready || terminalHistoryReads === 0)
        throw new Error("Cleanup must be reached through a terminal history observation");
      // The exact core owner deletes its commands-map entry before failing
      // command.done. Hold the HTTP acknowledgement, not that deletion.
      shell = false;
      trace.push("owned-shell-removed");
      if (scenario === "cleanup-abort") {
        // Shell.remove fails command.done. Shell.result then has no capture;
        // the shell Job fails, and notifyWhenDone admits a synthetic error
        // notification without resume:false. See pinned-source findings.
        notification = {
          id: "msg_owned_shell_notification",
          type: "synthetic",
          time: { created: 4 },
          text: `<shell id="${shellID}" state="error" command="owned-background-server">\nShell.NotFoundError\n</shell>`,
          description: "owned-background-server",
          metadata: { source: "shell", shellID, jobID: shellID, state: "error" },
        };
        trace.push("session.synthetic:shell:error");
        cleanupStep = {
          id: assistantID,
          type: "assistant",
          time: { created: 4 },
          content: [],
        };
        inference = true;
        trace.push("session.execution.started:cleanup");
        trace.push("session.step.started:cleanup");
      }
      if (scenario === "new-input-during-cleanup") {
        newerInput = true;
        trace.push("newer-input-admitted-during-cleanup");
      }
      if (scenario === "queued-shell-notification") queuedNotification = true;
      removalEntered.resolve();
      await Promise.race([
        release.promise,
        new Promise<never>((_, reject) => {
          if (request.signal.aborted) reject(new Error("Owned removal wait aborted"));
          else
            request.signal.addEventListener(
              "abort",
              () => reject(new Error("Owned removal wait aborted")),
              { once: true },
            );
        }),
      ]);
      request.signal.throwIfAborted();
      trace.push("owned-shell-delete-ack");
      notify();
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname.startsWith(`/api/session/${sessionID}/inbox/`) &&
      request.method === "DELETE"
    ) {
      cancellations++;
      if (url.pathname.endsWith("/msg_owned_queued_shell_notification")) {
        queuedNotification = false;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === `/api/session/${sessionID}/inbox` && queuedNotification)
      return Response.json({
        data: [
          {
            id: "msg_owned_queued_shell_notification",
            sessionID,
            type: "synthetic",
            time: { created: 4 },
            delivery: "steer",
            payload: {
              text: "Owned background shell was removed",
              metadata: { source: "shell", jobID: shellID, shellID, state: "error" },
            },
          },
        ],
      });
    if (url.pathname === `/api/session/${sessionID}/inbox` && newerInput)
      return Response.json({
        data: [
          {
            id: newerInputID,
            sessionID,
            type: "user",
            time: { created: 6 },
            delivery: "queue",
            payload: { text: "Owned newer input must not be discarded" },
          },
        ],
      });
    const response = await next(request, path);
    if (url.pathname !== `/api/session/${sessionID}/message` || !ready) return response;
    const body = (await response.json()) as { data: Message[]; cursor?: unknown };
    const successful = body.data.find((message) => message.type === "assistant");
    if (!successful?.time.completed)
      throw new Error("The maintained fixture must supply its real terminal assistant");
    terminalHistoryReads++;
    if (removals) postCleanupHistoryReads++;
    trace.push(removals ? "history-after-cleanup" : "history-before-cleanup");
    if (scenario === "provider-error" || scenario === "pre-cleanup-abort") {
      successful.finish = "error";
      successful.error = scenario === "provider-error" ? providerError : interruptedStep;
    }
    return Response.json({
      ...body,
      data: [
        ...(newerInput
          ? [
              {
                id: newerInputID,
                type: "user",
                time: { created: 6 },
                text: "Owned newer input must not be discarded",
              },
            ]
          : []),
        ...(cleanupStep ? [cleanupStep] : []),
        ...(notification ? [notification] : []),
        ...body.data,
      ],
    });
  };
  return {
    transport,
    removalEntered: removalEntered.promise,
    begin() {
      armed = true;
    },
    finish() {
      ready = true;
      inference = false;
      newerInput = scenario === "new-input-before-cleanup";
    },
    releaseRemoval() {
      release.resolve();
    },
    snapshot() {
      return {
        interrupts,
        removals,
        terminalHistoryReads,
        postCleanupHistoryReads,
        cancellations,
        inference,
        shell,
        newerInput,
        trace: [...trace],
      };
    },
    disable() {
      enabled = false;
      release.resolve();
    },
  };
}
