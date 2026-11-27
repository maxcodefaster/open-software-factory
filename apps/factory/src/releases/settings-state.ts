import { createEffect, createSignal, untrack } from "solid-js";
import { type ReleaseSettingsView, releaseVersion } from "#project-domain/release";
import { APIRequestError } from "../api-client";
import {
  createReleaseAccess,
  endProjectPublication,
  getProjectReleases,
  publishProjectRelease,
  reconcileProjectRelease,
  revokeReleaseAccess,
  rotateReleaseAccess,
} from "../server-functions/releases";
import { serverCall } from "../server-functions/result";
import { observeFactoryRead } from "../zero/reads";
import type {
  AccessCommand,
  ReleaseCommandState,
  ReleaseDialog,
  ReleasePanel,
} from "./settings-types";

export function createReleaseSettingsState(props: { projectID: string; active: boolean }) {
  const [view, setView] = createSignal<ReleaseSettingsView>();
  const [panel, setPanel] = createSignal<ReleasePanel>("versions");
  const [version, setVersion] = createSignal("");
  const [notes, setNotes] = createSignal("");
  const [name, setName] = createSignal("");
  const [scope, setScope] = createSignal<"git" | "packages">("git");
  const [loadError, setLoadError] = createSignal("");
  const [dialog, setDialog] = createSignal<ReleaseDialog>({ kind: "none" });
  const [command, setCommand] = createSignal<ReleaseCommandState>({ kind: "idle" });

  let alive = true;
  let generation = 0;
  let readSequence = 0;
  let shownProject = "";
  let accessCommand: AccessCommand | undefined;
  let observed = false;

  const busy = () => command().kind === "busy";
  const error = () => {
    const current = command();
    return current.kind === "error" ? current.message : "";
  };
  const notice = () => {
    const current = command();
    return current.kind === "notice" ? current.message : "";
  };

  async function load(projectID = props.projectID, signal?: AbortSignal) {
    const current = generation;
    const sequence = ++readSequence;
    try {
      const value = await serverCall(
        getProjectReleases({ data: [projectID], ...(signal ? { signal } : {}) }),
      );
      if (!alive || current !== generation || sequence !== readSequence || signal?.aborted) return;
      setView(value);
      setLoadError("");
    } catch {
      if (alive && current === generation && sequence === readSequence)
        setLoadError("Could not refresh releases. Refresh to try again.");
    }
  }

  async function runAction(execute: (current: () => boolean) => Promise<string | undefined>) {
    if (busy()) return;
    const epoch = generation;
    const current = () => alive && epoch === generation;
    setCommand({ kind: "busy" });
    try {
      const nextNotice = await execute(current);
      if (current()) await load();
      if (current()) {
        setCommand(nextNotice ? { kind: "notice", message: nextNotice } : { kind: "idle" });
      }
    } catch (cause) {
      if (current()) {
        setCommand({
          kind: "error",
          message:
            cause instanceof APIRequestError
              ? cause.message
              : "Release command outcome is unconfirmed. Refresh before trying again.",
        });
      }
    }
  }

  createEffect(
    () => [props.projectID, props.active] as const,
    ([projectID, active]) => {
      generation++;
      alive = true;
      setDialog({ kind: "none" });
      accessCommand = undefined;
      if (shownProject !== projectID) {
        shownProject = projectID;
        setPanel("versions");
        setView(undefined);
        setVersion("");
        setNotes("");
        setName("");
        setLoadError("");
        setCommand({ kind: "idle" });
      } else if (untrack(command).kind === "busy") {
        setCommand({ kind: "idle" });
      }
      if (!active) return;
      if (!observed) void load(projectID);
      return () => {
        alive = false;
        generation++;
      };
    },
  );

  observed = observeFactoryRead(
    () =>
      props.active
        ? { projectId: props.projectID, resourceId: props.projectID, scope: "releases" }
        : null,
    (signal) =>
      load(
        untrack(() => props.projectID),
        signal,
      ),
  );

  const activePublication = () =>
    Boolean(
      view()?.releases.some(
        (item) => !item.endedAt && !["published", "failed"].includes(item.state),
      ),
    );

  const versionError = () =>
    version() && !releaseVersion.safeParse(version()).success
      ? "Use a stable version such as 1.4.0, without a v prefix."
      : view()?.releases.some((item) => item.version === version())
        ? "This version is already reserved. Choose a new version."
        : "";

  // Only the empty version is explained here; every other blocker has its own message.
  const versionHint = () =>
    Boolean(
      !version() &&
        view()?.canPublish &&
        view()?.candidateSHA &&
        !loadError() &&
        !view()?.configurationError &&
        (!view()?.contract || view()?.configured) &&
        !activePublication(),
    );

  const canReview = () =>
    Boolean(
      view()?.canPublish &&
        view()?.candidateSHA &&
        !loadError() &&
        !view()?.configurationError &&
        (!view()?.contract || view()?.configured) &&
        !activePublication() &&
        version() &&
        !versionError(),
    );

  function choosePanel(value: ReleasePanel) {
    setPanel(value);
    setDialog({ kind: "none" });
    if (!busy()) setCommand({ kind: "idle" });
  }

  function refresh() {
    void runAction(async () => undefined);
  }

  function reviewPublication(commitSHA: string) {
    if (!untrack(canReview)) return;
    setDialog({
      kind: "confirm-publish",
      version: version(),
      commitSHA,
      notes: notes(),
      commandID: crypto.randomUUID(),
    });
  }

  function confirmPublish(pending: Extract<ReleaseDialog, { kind: "confirm-publish" }>) {
    void runAction(async (current) => {
      await serverCall(
        publishProjectRelease({
          data: [
            props.projectID,
            {
              version: pending.version,
              commitSHA: pending.commitSHA,
              notes: pending.notes,
              commandID: pending.commandID,
            },
          ],
        }),
      );
      if (!current()) return undefined;
      setDialog({ kind: "none" });
      setVersion("");
      setNotes("");
      return "Publication requested. Check Release history for its outcome.";
    });
  }

  function reconcileRelease(releaseID: string) {
    void runAction(async (current) => {
      await serverCall(reconcileProjectRelease({ data: [props.projectID, releaseID] }));
      return current() ? "Outcome checked. No new run was started." : undefined;
    });
  }

  function confirmEndAttempt(releaseID: string) {
    void runAction(async (current) => {
      await serverCall(endProjectPublication({ data: [props.projectID, releaseID] }));
      if (current()) setDialog({ kind: "none" });
      return undefined;
    });
  }

  function submitAccess() {
    void runAction(async (current) => {
      setDialog({ kind: "none" });
      if (accessCommand?.name !== name() || accessCommand?.scope !== scope()) {
        accessCommand = {
          commandID: crypto.randomUUID(),
          name: name(),
          scope: scope(),
        };
      }
      const result = await serverCall(
        createReleaseAccess({ data: [props.projectID, accessCommand] }),
      );
      if (!current()) return undefined;
      accessCommand = undefined;
      setDialog({
        kind: "show-credential",
        username: result.username,
        token: result.token,
        revealed: false,
      });
      setName("");
      return undefined;
    });
  }

  function confirmRotation(grantID: string, commandID: string) {
    void runAction(async (current) => {
      const result = await serverCall(
        rotateReleaseAccess({ data: [props.projectID, grantID, commandID] }),
      );
      if (!current()) return undefined;
      setDialog({
        kind: "show-credential",
        username: result.username,
        token: result.token,
        revealed: false,
      });
      return "Old access revoked. Install the replacement credential in the consumer.";
    });
  }

  function confirmRevocation(grantID: string) {
    void runAction(async (current) => {
      await serverCall(revokeReleaseAccess({ data: [props.projectID, grantID] }));
      if (!current()) return undefined;
      setDialog({ kind: "none" });
      return "Read access revoked. Already downloaded content cannot be recalled.";
    });
  }

  function toggleCredentialReveal() {
    setDialog((current) =>
      current.kind === "show-credential" ? { ...current, revealed: !current.revealed } : current,
    );
  }

  return {
    view,
    panel,
    version,
    setVersion,
    notes,
    setNotes,
    name,
    setName,
    scope,
    setScope,
    loadError,
    dialog,
    setDialog,
    busy,
    error,
    notice,
    activePublication,
    versionError,
    versionHint,
    canReview,
    choosePanel,
    refresh,
    reviewPublication,
    confirmPublish,
    reconcileRelease,
    confirmEndAttempt,
    submitAccess,
    confirmRotation,
    confirmRevocation,
    toggleCredentialReveal,
  };
}

export type ReleaseSettingsState = ReturnType<typeof createReleaseSettingsState>;
