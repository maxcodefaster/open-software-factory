package connector

import (
	"context"
	"path/filepath"
	"strings"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/gitops"
)

const (
	attemptLabel    = "factory.dev/runtime-attempt"
	generationLabel = "factory.dev/runtime-generation"
)

// parentOperations runs Parent operations one at a time, in order,
// off the control read loop. Cancelling its context kills an in-flight Git run.
type parentOperations struct {
	queue  chan parentOperation
	cancel context.CancelFunc
	done   chan struct{}
}

type parentOperation struct {
	control *controlConnection
	message Message
}

func startParentOperations(ctx context.Context, handle func(context.Context, Message) Message) *parentOperations {
	ctx, cancel := context.WithCancel(ctx)
	operations := &parentOperations{
		queue:  make(chan parentOperation, parentOperationQueueLimit),
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(operations.done)
		for {
			select {
			case <-ctx.Done():
				return
			case operation := <-operations.queue:
				response := handle(ctx, operation.message)
				if err := operation.control.Write(response); err != nil {
					// The operation may have completed. Recover the control connection,
					// never replay the operation or tear down its admitted compute.
					operation.control.Close()
				}
			}
		}
	}()
	return operations
}

func (operations *parentOperations) submit(control *controlConnection, message Message) bool {
	select {
	case operations.queue <- parentOperation{control: control, message: message}:
		return true
	default:
		return false
	}
}

func (operations *parentOperations) stop() {
	operations.cancel()
	<-operations.done
}

func handleParentOperation(ctx context.Context, assignment Assignment, message Message) Message {
	response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	if message.OperationID == "" {
		response.Error = "operation identity is required"
		return response
	}
	switch message.Action {
	case "source-drain":
		// Only the native controller may acknowledge Work's exact writer
		// barrier. There is no private-daemon drain fallback.
		response.Error = "Source drain requires the native Work writer barrier"
	case "workspace-git":
		result, err := personalGit(ctx, assignment, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.Data = result
		}
	case "skills-install":
		response.Error = errorText(installAdmittedSkills(ctx, assignment, message.Data))
	case "git-prepare-commit", "git-observe-commit", "git-prepare-integration":
		if assignment.NativeActorUID() != "" {
			ctx = gitops.WithNativeCommitGit(ctx, true)
		}
		commit, err := prepareCommit(ctx, assignment.WorkspaceFolder, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.CommitSHA = commit
		}
	case "git-push":
		if assignment.NativeActorUID() != "" {
			ctx = gitops.WithNativeCommitGit(ctx, true)
		}
		remote, err := pushCommit(ctx, assignment.WorkspaceFolder, message)
		if err != nil {
			response.Error = err.Error()
		} else {
			response.RemoteSHA = remote
		}
	default:
		response.Error = "unsupported parent operation"
	}
	return response
}

type composeFileResource struct {
	File string `json:"file"`
}

func pathWithin(root string, candidate string) bool {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return false
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedCandidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
