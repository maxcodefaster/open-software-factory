// Explicit application acceptance against an already restored, exclusively owned target.
// No installation, native lifecycle, repair SQL, model calls or retry of a write.
import imagePins from "../../deploy/helm/factory/image-pins.json";
import { loadApplicationFixture } from "./restore-application-fixture";
import { applicationBuildTree, pinnedApplicationRequest } from "./restore-application-http";
import { restoredApplicationContainersMatch } from "./restore-application-kubernetes";
import { applicationSQL, historyTables, idleRules } from "./restore-application-rules";
import {
  type ApplicationFixture,
  type ApplicationReceipt,
  type ApplicationWitnesses,
  type Command,
  check,
  type HTTPRequest,
  type HTTPResponse,
  type LoadedApplicationFixture,
  originalRepository,
  type Wire,
} from "./restore-application-types";
import { type CheckDependencies, runApplicationCheck } from "./restore-application-verify";

export {
  type ApplicationFixture,
  type ApplicationReceipt,
  type ApplicationWitnesses,
  applicationBuildTree,
  applicationSQL,
  type Command,
  type HTTPRequest,
  type HTTPResponse,
  historyTables,
  idleRules,
  type LoadedApplicationFixture,
  loadApplicationFixture,
  originalRepository,
  pinnedApplicationRequest,
  restoredApplicationContainersMatch,
  type Wire,
};

export function checkRestoredApplication(
  f: LoadedApplicationFixture,
  dependencies: CheckDependencies = {},
): Promise<ApplicationReceipt> {
  return runApplicationCheck(f, import.meta.filename, imagePins.zero, dependencies);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    check(
      args.length === 5 && args[0] === "--run" && args[1] === "--fixture" && args[3] === "--owner",
    );
    const fixture = await loadApplicationFixture(args[2] ?? "", args[4] ?? "");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const result = await checkRestoredApplication(fixture, { signal: controller.signal });
      console.log(
        `Restored application: ${result.status}; save ${result.save}; logout ${result.logout}; native recovery not qualified`,
      );
      process.exitCode = result.status === "restored-application-passed" ? 0 : 1;
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  } catch {
    console.error(
      "Restore application check refused or incomplete; private diagnostics suppressed",
    );
    process.exitCode = 1;
  }
}
