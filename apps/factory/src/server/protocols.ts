import { createApiProtocol } from "./protocols/api";
import { createEditorProtocol } from "./protocols/editor";
import { createHealthProtocol } from "./protocols/health";
import { createHooksProtocol } from "./protocols/hooks";
import { createInternalProtocol } from "./protocols/internal";
import { createRuntimeProtocol } from "./protocols/runtime";

export type FactoryProtocolServices = Parameters<typeof createApiProtocol>[0] &
  Parameters<typeof createInternalProtocol>[0] &
  Parameters<typeof createRuntimeProtocol>[0] &
  Parameters<typeof createHealthProtocol>[0] &
  Parameters<typeof createHooksProtocol>[0] &
  Parameters<typeof createEditorProtocol>[0];

export function createFactoryProtocols(application: FactoryProtocolServices) {
  return {
    api: createApiProtocol(application),
    internal: createInternalProtocol(application),
    runtime: createRuntimeProtocol(application),
    health: createHealthProtocol(application),
    hooks: createHooksProtocol(application),
    editor: createEditorProtocol(application),
  };
}
export type FactoryProtocols = ReturnType<typeof createFactoryProtocols>;
