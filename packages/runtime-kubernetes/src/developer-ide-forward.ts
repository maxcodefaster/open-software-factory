import { runServiceForward } from "./service-forward-process";
await runServiceForward("editor", process.argv.slice(2));
