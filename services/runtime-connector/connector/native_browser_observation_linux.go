package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/workspacefiles"
)

// The caller holds Source's read lock, inside the existing Parent Source fence.
// Neither the browser request nor a serialized assignment can supply this owner.
func validateNativeBrowserInspectionSource(assignment Assignment, source *nativeSourceOwner, actorUID string) error {
	if source == nil || assignment.NativeSource() != source || !source.ready.Load() ||
		source.service == nil || source.epoch.Load() == 0 ||
		assignment.WorkspaceFolder != "/var/lib/factory/source/project" ||
		assignment.ConnectorStateDir != nativeBootstrapStateDirectory ||
		!sourceRestoreUUID.MatchString(assignment.NativeActorUID()) || actorUID != assignment.NativeActorUID() {
		return errors.New("browser inspection native Source identity is unavailable or changed")
	}
	return nil
}

func handleNativeBrowserInspection(ctx context.Context, assignment Assignment, source *nativeSourceOwner, message Message) Message {
	response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
	scope, app, err := decodeBrowserInspectionRequest(message, assignment)
	if err == nil {
		err = workspacefiles.ValidateActorSourceIdentity("/var/lib/factory/source")
	}
	var actorUID []byte
	if err == nil {
		actorUID, err = os.ReadFile("/run/ate/identity/uid")
	}
	if err == nil {
		if source != nil {
			source.mu.RLock()
			defer source.mu.RUnlock()
		}
		err = validateNativeBrowserInspectionSource(assignment, source, strings.TrimSpace(string(actorUID)))
	}
	if err == nil {
		bounded, cancel := context.WithDeadline(ctx, scope.ExpiresAt)
		defer cancel()
		var inspection *browserInspectionContext
		inspection, err = readBrowserCheckoutContext(bounded, assignment, scope, app)
		if err == nil {
			var data []byte
			data, err = json.Marshal(inspection)
			response.Data = string(data)
		}
	}
	response.Error = errorText(err)
	return response
}
