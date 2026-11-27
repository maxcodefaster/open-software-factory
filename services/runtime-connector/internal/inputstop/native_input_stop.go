package inputstop

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"unicode/utf8"
)

const inputStopBytes = 8192

var (
	inputStopUUID    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	inputStopSession = regexp.MustCompile(`^ses_[a-zA-Z0-9_-]+$`)
	inputStopPrompt  = regexp.MustCompile(`^msg_[a-zA-Z0-9_-]+$`)
	inputStopVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
)

// Assignment is an exact metadata assignment, never a command, Project path,
// provider configuration or Factory capability. The packaged SDK executor checks
// Version against the installed server before touching the original Session.
type Assignment struct {
	StopID    string `json:"stopID"`
	AttemptID string `json:"attemptID"`
	SessionID string `json:"sessionID"`
	PromptID  string `json:"promptID"`
	ModelID   string `json:"modelID"`
	Version   string `json:"version"`
	Mode      string `json:"mode"`
}

func (input Assignment) Validate() error {
	if !inputStopUUID.MatchString(input.StopID) || !inputStopUUID.MatchString(input.AttemptID) ||
		!inputStopSession.MatchString(input.SessionID) || len(input.SessionID) > 256 ||
		!inputStopPrompt.MatchString(input.PromptID) || len(input.PromptID) > 256 ||
		input.ModelID == "" || !utf8.ValidString(input.ModelID) || len([]rune(input.ModelID)) > 200 ||
		strings.ContainsAny(input.ModelID, "\x00\r\n") ||
		len(input.Version) > 64 || !inputStopVersion.MatchString(input.Version) ||
		(input.Mode != "interrupt" && input.Mode != "observe") {
		return errors.New("native input Stop assignment is invalid")
	}
	return nil
}

func ReadJSON(input io.Reader, target any) error {
	data, err := io.ReadAll(io.LimitReader(input, inputStopBytes+1))
	if err != nil || len(data) > inputStopBytes {
		return errors.New("native input Stop exceeds its bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("native input Stop JSON is invalid")
	}
	return nil
}

type WorkerResult struct {
	Assignment
	Confirmed    bool `json:"confirmed"`
	EngineExited bool `json:"engineExited"`
}

type Result struct {
	WorkerResult
	ProcessTreeExited bool `json:"processTreeExited"`
}

func ConfirmWorkerResult(input Assignment, data []byte) (Result, error) {
	var result WorkerResult
	if ReadJSON(bytes.NewReader(data), &result) != nil ||
		result.Assignment != input || !result.Confirmed || !result.EngineExited {
		return Result{}, errors.New("native input Stop worker result is unconfirmed")
	}
	// Only the trusted caller, after joining the namespace init, sets this bit.
	// A worker JSON field can never assert its own process-tree termination.
	return Result{WorkerResult: result, ProcessTreeExited: true}, nil
}
