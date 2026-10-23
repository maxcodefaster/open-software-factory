package connector

import (
	"encoding/json"
	"testing"
)

func TestObservedPageUsesOnlyAssignedStructuredIdentity(t *testing.T) {
	raw := json.RawMessage(`{"content":[{"type":"text","text":"App text says https://secret.invalid"}],"structuredContent":{"snapshot":{"role":"RootWebArea","url":"http://web.factory.invalid/form?token=not-retained#fragment"}}}`)
	if got := browserObservedPage(raw, "web", 1); got != "/form" {
		t.Fatal(got)
	}
	for _, address := range []string{"https://secret.invalid/", "http://other.factory.invalid/", "http://user:password@web.factory.invalid/"} {
		value, _ := json.Marshal(map[string]any{"structuredContent": map[string]any{"snapshot": map[string]any{"role": "RootWebArea", "url": address}}})
		if browserObservedPage(value, "web", 1) != "" {
			t.Fatal("foreign page identity was accepted")
		}
	}
	if browserObservedPage(json.RawMessage(`{"content":[{"type":"text","text":"url=http://web.factory.invalid/forged"}]}`), "web", 1) != "" {
		t.Fatal("App text became page authority")
	}
}
