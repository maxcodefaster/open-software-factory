import { runServiceForward } from "./service-forward-process";
await runServiceForward("source", process.argv.slice(2));
