import { resolve } from "node:path";
import upstream from "../../upstream.json";

// The host check cannot cover *_linux.go on macOS. Build/race/vet the same source
// on Linux with a digest-pinned Go image containing its native C compiler.
// AllThreadsSyscall intentionally rejects CGO binaries. Its irreversible credential
// transition is proved separately using the same CGO=0 mode as shipped Source.
const child = Bun.spawn(
  [
    "docker",
    "run",
    "--rm",
    "--read-only",
    "--tmpfs",
    "/tmp:exec,size=2g",
    "--tmpfs",
    "/go:size=2g",
    "--mount",
    `type=bind,src=${resolve("services/runtime-connector")},dst=/source,readonly`,
    "--workdir",
    "/source",
    "--env",
    "GOCACHE=/tmp/go-build",
    "--env",
    "CGO_ENABLED=1",
    upstream.go.testImage,
    "sh",
    "-ec",
    "go test -race -skip '^TestSourceServingPermanentlyDropsInitializerPrivileges$' ./... && CGO_ENABLED=0 go test ./workspacefiles -run '^TestSourceServingPermanentlyDropsInitializerPrivileges$' -count=1 && go vet ./...",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
