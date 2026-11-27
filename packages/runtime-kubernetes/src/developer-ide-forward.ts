import { runServiceForward } from "./service-forward-process";

await runServiceForward(process.argv.slice(2));
