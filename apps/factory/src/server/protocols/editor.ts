import type { FactoryApplication } from "../application";

import { protocolFailure } from "./failure";

type EditorServices = Pick<FactoryApplication, "developerIDEEdge">;
export function createEditorProtocol(services: EditorServices) {
  const { developerIDEEdge } = services;
  return async (request: Request): Promise<Response> => {
    try {
      return await developerIDEEdge.route(request);
    } catch (cause) {
      return protocolFailure(request, cause);
    }
  };
}
