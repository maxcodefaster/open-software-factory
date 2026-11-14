import type { DisposableInstallation } from "./installation";
import { requireResetConfirmation } from "./installation";

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
