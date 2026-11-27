package browser

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

// Private Parent operation, not a public MCP tool. Only the declared App crosses
// this boundary; Source location and Git commands always come from Factory.
func DecodeInspectionRequest(message protocol.Message, assignment protocol.Assignment) (RuntimeRequest, string, error) {
	return decodeBrowserInspectionRequest(message, assignment)
}

func decodeBrowserInspectionRequest(message protocol.Message, assignment protocol.Assignment) (browserRuntimeRequest, string, error) {
	if message.Type != "operation-request" || message.Action != "browser-inspection" ||
		assignment.RuntimeAttemptID == "" || assignment.Generation == 0 {
		return browserRuntimeRequest{}, "", errors.New("browser inspection requires its exact Parent operation")
	}
	scope, err := decodeBrowserRuntimeRequest(message, assignment)
	if err != nil {
		return scope, "", err
	}
	var arguments struct {
		App string `json:"app"`
	}
	decoder := json.NewDecoder(bytes.NewReader(scope.Call.Arguments))
	decoder.DisallowUnknownFields()
	if scope.Call.Name != "browser-inspection" || decoder.Decode(&arguments) != nil ||
		decoder.Decode(new(any)) != io.EOF || !protocol.ChannelPattern.MatchString(arguments.App) {
		return scope, "", errors.New("browser inspection requires only its declared App")
	}
	for _, channel := range assignment.Channels {
		if channel.Kind == "app" && channel.Name == arguments.App {
			return scope, arguments.App, nil
		}
	}
	return scope, "", errors.New("browser App is not declared in this Workspace")
}
