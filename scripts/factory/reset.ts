import type { DisposableInstallation } from "./installation";
import { requireResetConfirmation } from "./installation";

export async function requireRuntimeNamespacesAbsent(
  namespaces: readonly string[],
  observe: (namespace: string) => Promise<boolean>,
) {
  for (const namespace of namespaces)
    if (await observe(namespace))
      throw new Error(
        "Reset refused: finish runtime and retained Workspace cleanup before deleting its disposable installation",
      );
}

export async function resetDisposable(input: {
  installation: DisposableInstallation | null;
  confirmation: string | undefined;
  data: boolean;
  validate: () => Promise<void>;
  persistIntent: () => Promise<void>;
  stop: () => Promise<void>;
  remove: () => Promise<void>;
  persistOutcome: () => Promise<void>;
}) {
  requireResetConfirmation(input.installation, input.confirmation, input.data);
  await input.validate();
  await input.persistIntent();
  await input.stop();
  await input.remove();
  await input.persistOutcome();
}
