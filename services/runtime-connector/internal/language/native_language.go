package language

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/procutil"
	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

// The native image volume exposes the entire tools image, not just /opt/factory.
// Its packaged libc variants stay read-only; there is no injected runtime/ tree.
const NativeToolsRoot = "/opt/factory-tools" + ToolsRoot

func nativeLanguageCommand(ctx context.Context, assignment protocol.Assignment, root, language string) (*exec.Cmd, error) {
	script := ""
	switch language {
	case "typescript":
		script = "typescript-language-server/lib/cli.mjs"
	case "python":
		script = "pyright/langserver.index.js"
	default:
		return nil, errors.New("unsupported native language")
	}
	script = filepath.Join(root, "node_modules", script)
	if info, err := os.Stat(script); err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("native language server is not packaged")
	}
	environment := procutil.AssignedEnvironment(os.Environ(), assignment.RuntimeEnvironment)
	probeContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for _, libc := range []string{"glibc", "musl"} {
		runtime := filepath.Join(root, libc)
		node := filepath.Join(runtime, "node")
		// Execute the shipped binary against the Project's own loader/libc.
		// Merely finding a loader or running Project-selected ldd does not prove
		// the packaged Node ABI works. Never install a loader or select PATH's node.
		probe := exec.CommandContext(probeContext, node, "--version")
		probe.Dir = assignment.WorkspaceFolder
		probe.Env = languageEnvironment(environment, runtime)
		probe.Stdout, probe.Stderr = io.Discard, io.Discard
		procutil.PrepareAssignedProcess(probe)
		probe.Cancel = func() error { procutil.StopAssignedProcess(probe); return nil }
		err := assignment.StartNativeWriter(probe.Start)
		if err == nil {
			err = probe.Wait()
		}
		if probeContext.Err() != nil {
			return nil, probeContext.Err()
		}
		if err != nil {
			continue
		}
		command := exec.CommandContext(ctx, node, script, "--stdio")
		command.Dir = assignment.WorkspaceFolder
		command.Env = languageEnvironment(environment, runtime)
		command.Stderr = io.Discard
		procutil.PrepareAssignedProcess(command)
		return command, nil
	}
	return nil, errors.New("native language tools require a runnable packaged glibc or musl Node")
}
