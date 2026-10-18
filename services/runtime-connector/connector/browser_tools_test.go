package connector

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBrowserToolAllowlistAndFixedBounds(t *testing.T) {
	channels := []Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}}
	for _, test := range []struct{ name, arguments, upstream string }{
		{"browser_open", `{"app":"web","path":"/settings?panel=general"}`, "navigate_page"},
		{"browser_snapshot", `{}`, "take_snapshot"},
		{"browser_console", `{}`, "list_console_messages"},
		{"browser_screenshot", `{}`, "take_screenshot"},
		{"browser_click", `{"uid":"1_12"}`, "click"},
		{"browser_fill", `{"uid":"1_12","value":"New title"}`, "fill"},
		{"browser_wait", `{"text":"Saved"}`, "wait_for"},
		{"browser_resize", `{"width":390,"height":720}`, "resize_page"},
		{"browser_press_key", `{"key":"Tab"}`, "press_key"},
	} {
		t.Run(test.name, func(t *testing.T) {
			call, err := resolveBrowserTool(channels, 2, browserToolCall{Name: test.name, Arguments: json.RawMessage(test.arguments)})
			if err != nil || call.Name != test.upstream || call.Arguments["pageId"] != 2 {
				t.Fatalf("unexpected bounded tool dispatch: %+v %v", call, err)
			}
			if test.name == "browser_open" && call.Arguments["url"] != "http://web.factory.invalid/settings?panel=general" {
				t.Fatal("App origin was not pinned")
			}
			if test.name == "browser_screenshot" && (call.Arguments["fullPage"] != false || call.Arguments["format"] != "jpeg" || call.Arguments["quality"] != 75) {
				t.Fatal("screenshot bounds were not fixed")
			}
			if test.name == "browser_resize" && (call.Arguments["width"] != 390 || call.Arguments["height"] != 720) {
				t.Fatal("viewport dimensions changed during dispatch")
			}
			if test.name == "browser_press_key" && call.Arguments["key"] != "Tab" {
				t.Fatal("keyboard intent changed during dispatch")
			}
		})
	}
}

func TestBrowserToolsRejectURLsFilesScriptsUnknownArgumentsAndPages(t *testing.T) {
	channels := []Channel{
		{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"},
		{Name: "ide", Kind: "ide", Target: "http://127.0.0.1:4400"},
	}
	for _, test := range []struct{ name, arguments string }{
		{"evaluate_script", `{"function":"() => fetch('http://metadata/')"}`},
		{"new_page", `{"url":"http://web.factory.invalid/"}`},
		{"upload_file", `{"filePath":"/etc/passwd"}`},
		{"browser_open", `{"app":"ide"}`},
		{"browser_open", `{"app":"other"}`},
		{"browser_open", `{"app":"web","path":"//metadata/"}`},
		{"browser_open", `{"app":"web","path":"/\\metadata/"}`},
		{"browser_open", `{"app":"web","path":"http://metadata/"}`},
		{"browser_open", `{"app":"web","url":"http://metadata/"}`},
		{"browser_snapshot", `{"filePath":"/tmp/leak"}`},
		{"browser_screenshot", `{"fullPage":true}`},
		{"browser_console", `{"pageSize":10000}`},
		{"browser_click", `{"uid":"1_2","pageId":999}`},
		{"browser_fill", `{"uid":"../file","value":"new"}`},
		{"browser_resize", `{"width":319,"height":720}`},
		{"browser_resize", `{"width":1281,"height":720}`},
		{"browser_resize", `{"width":390,"height":721}`},
		{"browser_resize", `{"width":390,"height":0}`},
		{"browser_resize", `{"width":390.5,"height":720}`},
		{"browser_resize", `{"width":390,"height":720,"pageId":999}`},
		{"browser_press_key", `{"key":"Control+L"}`},
		{"browser_press_key", `{"key":"Enter","text":"script"}`},
		{"browser_snapshot", `null`},
		{"browser_snapshot", `{} {}`},
	} {
		t.Run(test.name+test.arguments, func(t *testing.T) {
			if call, err := resolveBrowserTool(channels, 2, browserToolCall{Name: test.name, Arguments: json.RawMessage(test.arguments)}); err == nil {
				t.Fatalf("unsupported authority reached upstream: %+v", call)
			}
		})
	}
	if _, err := resolveBrowserTool(channels, 0, browserToolCall{Name: "browser_snapshot", Arguments: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("inspection without an opened App was allowed")
	}
	for _, call := range []browserToolCall{
		{Name: "browser_resize", Arguments: json.RawMessage(`{"width":390,"height":720}`)},
		{Name: "browser_press_key", Arguments: json.RawMessage(`{"key":"Enter"}`)},
	} {
		if _, err := resolveBrowserTool(channels, 0, call); err == nil {
			t.Fatal("viewport or keyboard control without an opened App was allowed")
		}
	}
}

func TestBrowserObservationsBoundTextAcrossContentAndDenyFiles(t *testing.T) {
	encoded, _ := json.Marshal(map[string]any{"content": []any{
		map[string]string{"type": "text", "text": strings.Repeat("ä", 20000)},
		map[string]string{"type": "text", "text": strings.Repeat("x", 20000)},
	}})
	for _, test := range []struct {
		name string
		max  int
	}{{"browser_snapshot", 32 << 10}, {"browser_console", 8 << 10}} {
		bounded, err := boundBrowserResult(test.name, encoded)
		if err != nil {
			t.Fatal(err)
		}
		total := 0
		notice := false
		for _, item := range bounded.Content {
			total += len(item.Text)
			notice = notice || strings.Contains(item.Text, "Factory truncated")
			if !utf8.ValidString(item.Text) {
				t.Fatal("truncation broke UTF-8")
			}
		}
		if total > test.max || total == 0 || !notice {
			t.Fatalf("incorrect total text bound %d", total)
		}
		wire, err := json.Marshal(bounded)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			Content []map[string]any `json:"content"`
		}
		if json.Unmarshal(wire, &decoded) != nil {
			t.Fatal("invalid bounded wire result")
		}
		for _, item := range decoded.Content {
			if _, present := item["text"]; !present {
				t.Fatal("truncated text disappeared from the fixed wire schema")
			}
		}
	}
	for _, invalid := range []string{
		`{"content":[{"type":"resource_link","uri":"file:///tmp/leak"}]}`,
		`{"content":[{"type":"image","mimeType":"image/jpeg","data":"invalid"}]}`,
		`{"content":[{"type":"text","text":"a","data":"leak"}]}`,
	} {
		if _, err := boundBrowserResult("browser_snapshot", []byte(invalid)); err == nil {
			t.Fatal("unsupported browser content was exposed")
		}
	}
}
