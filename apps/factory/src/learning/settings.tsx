import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { LearningView } from "../../../../packages/conversation-domain/src/learning";
import {
  decideLearning,
  getLearning,
  rollbackLearning,
  saveLearning,
} from "../server-functions/learning";
import { serverCall } from "../server-functions/result";
import { LearningDashboard } from "./dashboard";

export function LearningSettings(props: {
  projectID?: string | undefined;
  onOpenTicket?: ((id: string, projectId: string) => void) | undefined;
}) {
  const [personal, setPersonal] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const [view, setView] = createSignal<LearningView>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  let epoch = 0;
  let retry: { key: string; commandId: string } | undefined;
  let focusAfterRead: string | undefined;
  let waitingRead: { version: number; resolve: () => void } | undefined;
  const target = () => `${props.projectID ?? "factory"}:${personal()}`;
  const read = createMemo(() => {
    const version = revision();
    const scope = target();
    return serverCall(getLearning({ data: [props.projectID ?? null, personal()] })).then(
      (value) => ({ scope, version, value }),
      (cause: unknown) => ({
        scope,
        version,
        error: cause instanceof Error ? cause.message : "Monitoring is unavailable",
      }),
    );
  });
  createEffect(target, () => {
    waitingRead?.resolve();
    waitingRead = undefined;
    epoch++;
    setView(undefined);
    setError("");
    setNotice("");
    setBusy(false);
    retry = undefined;
    focusAfterRead = undefined;
    return () => {
      epoch++;
      waitingRead?.resolve();
      waitingRead = undefined;
      focusAfterRead = undefined;
    };
  });
  createEffect(read, (result) => {
    if (result.scope !== target()) return;
    if ("value" in result) {
      setView(result.value);
      setError("");
      const focus = focusAfterRead;
      focusAfterRead = undefined;
      if (focus) {
        const generation = epoch;
        requestAnimationFrame(() => {
          if (generation === epoch) {
            const element = document.getElementById(focus);
            element?.scrollIntoView({ block: "nearest", behavior: "instant" });
            element?.focus({ preventScroll: true });
          }
        });
      }
    } else setError(result.error);
    if (waitingRead?.version === result.version) {
      waitingRead.resolve();
      waitingRead = undefined;
    }
  });
  async function command(
    key: string,
    run: (id: string) => Promise<unknown>,
    focus?: (result: unknown) => string | undefined,
  ) {
    if (busy()) return;
    if (retry?.key !== key) retry = { key, commandId: crypto.randomUUID() };
    const generation = epoch;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await run(retry.commandId);
      if (generation === epoch) {
        retry = undefined;
        setNotice("Saved");
        focusAfterRead = focus?.(value);
        const fresh = Promise.withResolvers<void>();
        const version = revision() + 1;
        waitingRead = { version, resolve: fresh.resolve };
        setRevision(version);
        await fresh.promise;
      }
    } catch (cause) {
      if (generation === epoch)
        setError(
          cause instanceof Error
            ? cause.message
            : "The command is unconfirmed. Retry the same action or refresh.",
        );
    } finally {
      if (generation === epoch) setBusy(false);
    }
  }
  return (
    <div class="work-settings">
      <Show when={props.projectID}>
        <fieldset class="work-scope" aria-label="Learning context">
          <button
            type="button"
            aria-pressed={!personal() ? "true" : "false"}
            onClick={() => setPersonal(false)}
          >
            Shared Project work
          </button>
          <button
            type="button"
            aria-pressed={personal() ? "true" : "false"}
            onClick={() => setPersonal(true)}
          >
            My private work
          </button>
        </fieldset>
      </Show>
      <Show when={error()}>
        <p class="work-error" role="alert">
          {error()}{" "}
          <button
            type="button"
            class="text-button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh monitoring
          </button>
        </p>
      </Show>
      <Show when={notice()}>
        <p class="work-note" role="status">
          {notice()}
        </p>
      </Show>
      <Show
        when={view()}
        fallback={
          <div
            class="work-loading"
            role="status"
            aria-label="Loading monitoring"
            aria-busy="true"
          />
        }
      >
        {(current) => (
          <LearningDashboard
            view={current()}
            busy={busy() || Boolean(error())}
            onOpenTicket={props.onOpenTicket}
            onToggle={() => {
              const projectId = props.projectID;
              if (!projectId) return;
              const value = current();
              void command(`policy:${target()}:${value.version}:${!value.enabled}`, (id) =>
                serverCall(
                  saveLearning({
                    data: [
                      {
                        commandId: id,
                        projectId,
                        scope: personal() ? "personal" : "project",
                        expectedVersion: value.version,
                        enabled: !value.enabled,
                        automaticSkills: value.automaticSkills,
                      },
                    ],
                  }),
                ),
              );
            }}
            onAutomaticToggle={() => {
              const projectId = props.projectID;
              if (!projectId) return;
              const value = current();
              void command(
                `automatic:${target()}:${value.version}:${!value.automaticSkills}`,
                (id) =>
                  serverCall(
                    saveLearning({
                      data: [
                        {
                          commandId: id,
                          projectId,
                          scope: personal() ? "personal" : "project",
                          expectedVersion: value.version,
                          enabled: value.enabled,
                          automaticSkills: !value.automaticSkills,
                        },
                      ],
                    }),
                  ),
              );
            }}
            onDecide={(id, decision, releasePrivate, editDigest) =>
              void command(
                `${id}:${decision}:${releasePrivate}:${editDigest ?? ""}`,
                (commandId) =>
                  serverCall(
                    decideLearning({
                      data: [
                        {
                          commandId,
                          proposalId: id,
                          decision,
                          releasePrivate,
                          editDigest: editDigest ?? null,
                        },
                      ],
                    }),
                  ),
                (result) =>
                  result &&
                  typeof result === "object" &&
                  "applicationId" in result &&
                  typeof result.applicationId === "string"
                    ? `work-application-${result.applicationId}`
                    : undefined,
              )
            }
            onRollback={(id, revisionId) =>
              void command(
                `undo:${id}:${revisionId}`,
                (commandId) =>
                  serverCall(
                    rollbackLearning({
                      data: [
                        {
                          commandId,
                          applicationId: id,
                          expectedRevisionId: revisionId,
                        },
                      ],
                    }),
                  ),
                () => `work-application-${id}`,
              )
            }
          />
        )}
      </Show>
      <button
        type="button"
        class="text-button work-refresh"
        disabled={busy()}
        onClick={() => setRevision((value) => value + 1)}
      >
        Refresh observations
      </button>
    </div>
  );
}
