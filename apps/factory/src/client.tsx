import { hydrate } from "@solidjs/web";
import { hydrateStart, StartClient } from "@tanstack/solid-start/client";
import { retainAttachmentDraft } from "./server-functions/attachments";
import { configureFactoryFunctionClient } from "./server-functions/client-transport";

configureFactoryFunctionClient(retainAttachmentDraft);
const router = await hydrateStart();
hydrate(() => <StartClient router={router} />, document);
