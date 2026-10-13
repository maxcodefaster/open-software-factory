import { z } from "zod";

const pendingCommandSchema = z.object({
  scope: z.string().min(1).max(500),
  input: z.string().max(80_000),
  commandId: z.uuid(),
  draft: z.string().max(12_000).optional(),
});
const journalSchema = z.array(pendingCommandSchema).max(50);

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type PendingCommand = z.infer<typeof pendingCommandSchema>;

export function createAgentCommandIds(options: { userId: string; storage: RecoveryStorage }) {
  const key = `factory:agent-commands:${encodeURIComponent(options.userId)}`;
  function read(): PendingCommand[] {
    let value: string | null;
    try {
      value = options.storage.getItem(key);
    } catch {
      throw new Error("Browser recovery storage is unavailable. No agent request was sent.");
    }
    if (value === null) return [];
    try {
      if (value.length > 4_000_000) throw new Error("Oversized journal");
      return journalSchema.parse(JSON.parse(value));
    } catch {
      throw new Error("Browser recovery data is unreadable. New agent requests are blocked.");
    }
  }
  function write(commands: PendingCommand[]) {
    const encoded = JSON.stringify(commands);
    if (encoded.length > 4_000_000)
      throw new Error("Browser recovery data is full. Recover unconfirmed requests first.");
    try {
      if (commands.length) options.storage.setItem(key, encoded);
      else options.storage.removeItem(key);
    } catch {
      throw new Error(
        "Browser recovery storage is unavailable. Unconfirmed requests are retained.",
      );
    }
  }
  return {
    forInput(scope: string, input: string, draft?: string) {
      const pending = read();
      const previous = pending.find(
        (command) => command.scope === scope && command.input === input,
      );
      if (previous) return previous.commandId;
      if (pending.length >= 50)
        throw new Error("Too many unconfirmed agent requests. Recover existing work first.");
      const command = pendingCommandSchema.parse({
        scope,
        input,
        commandId: crypto.randomUUID(),
        ...(draft === undefined ? {} : { draft }),
      });
      write([...pending, command]);
      return command.commandId;
    },
    latest(scope: string) {
      return read().findLast((command) => command.scope === scope);
    },
    forget(scope: string, ...commandIds: string[]) {
      const pending = read();
      const acknowledged = new Set(commandIds);
      const remaining = pending.filter(
        (command) => command.scope !== scope || !acknowledged.has(command.commandId),
      );
      if (remaining.length === pending.length) return false;
      write(remaining);
      return true;
    },
  };
}
