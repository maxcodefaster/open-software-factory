package browser

import (
	"encoding/json"
	"net/url"
	"regexp"
)

var CommitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var browserCommitPattern = CommitPattern

type InspectionContext struct {
	SessionID           string `json:"sessionId"`
	TurnID              string `json:"turnId"`
	AttemptID           string `json:"runtimeAttemptId"`
	Generation          uint64 `json:"generation"`
	App                 string `json:"app"`
	HeadCommit          string `json:"headCommit"`
	WorkingTreeModified bool   `json:"workingTreeModified"`
	ObservedAt          string `json:"observedAt"`
	RecordingTimeMS     *int64 `json:"recordingTimeMs,omitempty"`
	Page                string `json:"page,omitempty"`
}

type browserInspectionContext = InspectionContext

// Read only upstream's structured page identity, never a URL quoted in App text.
// Query strings and fragments do not enter retained review evidence.
func browserObservedPage(raw json.RawMessage, app string, pageID int) string {
	var result struct {
		Structured struct {
			Snapshot struct {
				Role string `json:"role"`
				URL  string `json:"url"`
			} `json:"snapshot"`
			Pages []struct {
				ID       int    `json:"id"`
				URL      string `json:"url"`
				Selected bool   `json:"selected"`
			} `json:"pages"`
			NavigatedToURL string `json:"navigatedToUrl"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return ""
	}
	address := result.Structured.NavigatedToURL
	for _, page := range result.Structured.Pages {
		if page.ID == pageID && page.Selected {
			address = page.URL
		}
	}
	if result.Structured.Snapshot.Role == "RootWebArea" {
		address = result.Structured.Snapshot.URL
	}
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "http" || parsed.Host != app+".factory.invalid" || parsed.User != nil {
		return ""
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	if len(path) > 2048 {
		return ""
	}
	return path
}
