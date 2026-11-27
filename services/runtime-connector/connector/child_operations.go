package connector

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
)

func (runtime *childRuntime) isDevelopment() bool {
	return runtime.processes != nil && runtime.processes.Development()
}

func (runtime *childRuntime) handleOperation(message Message) {
	if gate := runtime.assignment.NativeWriters(); gate != nil {
		if message.Action == "source-drain" {
			response := Message{Type: "operation-response", OperationID: message.OperationID, Action: message.Action}
			if message.OperationID == "" {
				response.Error = "operation identity is required"
			} else {
				response.Error = errorText(gate.Freeze(runtime.commands.Context()))
			}
			_ = runtime.send(response)
			return
		}
		release, fenced := gate.EnterOperation()
		if fenced {
			_ = runtime.send(Message{
				Type:        "operation-response",
				OperationID: message.OperationID,
				Action:      message.Action,
				Error:       "native Source writers are fenced",
			})
			return
		}
		defer release()
	}
	response := Message{
		Type:        "operation-response",
		OperationID: message.OperationID,
		Action:      message.Action,
		Process:     message.Process,
		TerminalID:  message.TerminalID,
	}
	switch {
	case message.OperationID == "":
		response.Error = "operation identity is required"
	case strings.HasPrefix(message.Action, "process-"):
		response.Error = errorText(runtime.processes.Action(message.Process, message.Action))
	case message.Action == "terminal-close":
		response.Error = errorText(runtime.terminals.Close(message.TerminalID))
	case strings.HasPrefix(message.Action, "file-") && runtime.files != nil && runtime.isDevelopment():
		value, err := runtime.handleFileOperation(message)
		encodeOperationResult(&response, value, err)
	case strings.HasPrefix(message.Action, "pty-") && runtime.isDevelopment() && runtime.terminals != nil:
		view, err := runtime.handlePTYOperation(message)
		encodeOperationResult(&response, view, err)
	case strings.HasPrefix(message.Action, "command-") && runtime.isDevelopment() && runtime.commands != nil:
		view, err := runtime.handleCommandOperation(message)
		encodeOperationResult(&response, view, err)
	default:
		response.Error = "unsupported child operation"
	}
	_ = runtime.send(response)
}

func (runtime *childRuntime) handleFileOperation(message Message) (any, error) {
	input, err := decodeOperationJSON[ContainerFileRequest](message.Data)
	if err != nil {
		return nil, err
	}
	switch message.Action {
	case "file-context":
		fileContext := map[string]any{"workspaceFolder": runtime.assignment.WorkspaceFolder, "userID": os.Geteuid()}
		if runtime.assignment.CheckoutFolder != "" {
			fileContext["checkoutFolder"] = runtime.assignment.CheckoutFolder
		}
		return fileContext, nil
	case "file-stat":
		return runtime.files.Stat(input)
	case "file-read":
		return runtime.files.Read(input)
	case "file-list":
		return runtime.files.List(input)
	case "file-mkdir", "file-delete", "file-rename":
		return runtime.files.Mutate(message.Action, input)
	case "file-upload-begin":
		return runtime.files.BeginUpload(input)
	case "file-upload-chunk":
		return runtime.files.Upload(input)
	case "file-upload-commit":
		return runtime.files.CommitUpload(input)
	case "file-download-begin":
		return runtime.files.BeginDownload(input)
	case "file-download-chunk":
		return runtime.files.Download(input)
	case "file-release":
		err := runtime.files.Release(input)
		return map[string]bool{"released": err == nil}, err
	case "file-transfer-status":
		return runtime.files.Status(input)
	default:
		return nil, errors.New("unsupported container file operation")
	}
}

func (runtime *childRuntime) handlePTYOperation(message Message) (CommandView, error) {
	switch message.Action {
	case "pty-open":
		input, err := decodeOperationJSON[CommandRequest](message.Data)
		if err != nil {
			return CommandView{}, err
		}
		return runtime.terminals.OpenCommand(input)
	case "pty-read", "pty-close":
		input, err := decodeOperationJSON[CommandRead](message.Data)
		if err != nil {
			return CommandView{}, err
		}
		if message.Action == "pty-read" {
			return runtime.terminals.ReadCommand(input)
		}
		return runtime.terminals.CloseCommand(input)
	case "pty-input", "pty-resize":
		input, err := decodeOperationJSON[terminalCommandInput](message.Data)
		if err != nil {
			return CommandView{}, err
		}
		return runtime.terminals.InputCommand(input, message.Action == "pty-resize")
	default:
		return CommandView{}, errors.New("unsupported PTY operation")
	}
}

func (runtime *childRuntime) handleCommandOperation(message Message) (CommandView, error) {
	if message.Action == "command-start" {
		input, err := decodeOperationJSON[CommandRequest](message.Data)
		if err != nil {
			return CommandView{}, err
		}
		return runtime.commands.Start(input)
	}
	input, err := decodeOperationJSON[CommandRead](message.Data)
	if err != nil {
		return CommandView{}, err
	}
	switch message.Action {
	case "command-read":
		return runtime.commands.Read(input)
	case "command-cancel":
		return runtime.commands.Cancel(input.ID)
	default:
		return CommandView{}, errors.New("unsupported command operation")
	}
}

func decodeOperationJSON[T any](raw string) (T, error) {
	var input T
	err := json.Unmarshal([]byte(raw), &input)
	return input, err
}

func encodeOperationResult(response *Message, value any, err error) {
	response.Error = errorText(err)
	if err == nil {
		data, encodeErr := json.Marshal(value)
		response.Error = errorText(encodeErr)
		response.Data = string(data)
	}
}
