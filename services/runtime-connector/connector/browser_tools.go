package connector

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/jpeg"
	"io"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

var browserUIDPattern = regexp.MustCompile(`^[0-9]{1,12}_[0-9]{1,12}$`)

type browserToolCall struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type browserMCPReply struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

type browserToolDispatch struct {
	Name      string
	Arguments map[string]any
	App       string
}

// This is Factory's tool allowlist, not an upstream MCP registry. Agents choose
// an assigned App name and relative path, never an origin, port or filesystem.
func resolveBrowserTool(channels []Channel, pageID int, call browserToolCall) (browserToolDispatch, error) {
	denied := errors.New("unsupported browser tool or arguments")
	decode := func(value any) error {
		if len(call.Arguments) > 8192 || !bytes.HasPrefix(bytes.TrimSpace(call.Arguments), []byte("{")) {
			return denied
		}
		decoder := json.NewDecoder(bytes.NewReader(call.Arguments))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(value); err != nil {
			return denied
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return denied
		}
		return nil
	}
	if call.Name == "browser_open" {
		var arguments struct {
			App  string `json:"app"`
			Path string `json:"path"`
		}
		if decode(&arguments) != nil {
			return browserToolDispatch{}, denied
		}
		if arguments.Path == "" {
			arguments.Path = "/"
		}
		if len(arguments.Path) > 2048 || !strings.HasPrefix(arguments.Path, "/") ||
			strings.HasPrefix(arguments.Path, "//") || strings.ContainsAny(arguments.Path, "\\\r\n\x00") {
			return browserToolDispatch{}, denied
		}
		path, err := url.ParseRequestURI(arguments.Path)
		if err != nil || path.IsAbs() || path.Host != "" {
			return browserToolDispatch{}, denied
		}
		for _, channel := range channels {
			if channel.Kind == "app" && channel.Name == arguments.App && channelPattern.MatchString(channel.Name) {
				upstream := browserToolDispatch{
					Name: "new_page", App: channel.Name,
					Arguments: map[string]any{"url": "http://" + channel.Name + ".factory.invalid" + arguments.Path, "timeout": 10000},
				}
				if pageID > 0 {
					upstream.Name = "navigate_page"
					upstream.Arguments["pageId"] = pageID
				}
				return upstream, nil
			}
		}
		return browserToolDispatch{}, errors.New("browser App is not declared in this Workspace")
	}
	if pageID <= 0 {
		return browserToolDispatch{}, errors.New("open a declared App before inspecting it")
	}
	upstream := browserToolDispatch{Arguments: map[string]any{"pageId": pageID}}
	switch call.Name {
	case "browser_snapshot", "browser_console", "browser_screenshot":
		if decode(&struct{}{}) != nil {
			return browserToolDispatch{}, denied
		}
		switch call.Name {
		case "browser_snapshot":
			upstream.Name = "take_snapshot"
			upstream.Arguments["verbose"] = false
		case "browser_console":
			upstream.Name = "list_console_messages"
			upstream.Arguments["pageSize"] = 20
			upstream.Arguments["includePreservedMessages"] = false
			upstream.Arguments["includeStackTraces"] = false
		case "browser_screenshot":
			upstream.Name = "take_screenshot"
			upstream.Arguments["format"] = "jpeg"
			upstream.Arguments["quality"] = 75
			upstream.Arguments["fullPage"] = false
		}
	case "browser_click":
		var arguments struct {
			UID string `json:"uid"`
		}
		if decode(&arguments) != nil || !browserUIDPattern.MatchString(arguments.UID) {
			return browserToolDispatch{}, denied
		}
		upstream.Name = "click"
		upstream.Arguments["uid"] = arguments.UID
		upstream.Arguments["includeSnapshot"] = false
	case "browser_fill":
		var arguments struct {
			UID   string `json:"uid"`
			Value string `json:"value"`
		}
		if decode(&arguments) != nil || !browserUIDPattern.MatchString(arguments.UID) ||
			len(arguments.Value) > 4096 || strings.ContainsRune(arguments.Value, 0) {
			return browserToolDispatch{}, denied
		}
		upstream.Name = "fill"
		upstream.Arguments["uid"] = arguments.UID
		upstream.Arguments["value"] = arguments.Value
		upstream.Arguments["includeSnapshot"] = false
	case "browser_wait":
		var arguments struct {
			Text string `json:"text"`
		}
		if decode(&arguments) != nil || len(arguments.Text) == 0 || len(arguments.Text) > 256 {
			return browserToolDispatch{}, denied
		}
		upstream.Name = "wait_for"
		upstream.Arguments["text"] = []string{arguments.Text}
		upstream.Arguments["timeout"] = 5000
	case "browser_resize":
		var arguments struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		}
		if decode(&arguments) != nil || arguments.Width < 320 || arguments.Width > 1280 ||
			arguments.Height < 240 || arguments.Height > 720 {
			return browserToolDispatch{}, denied
		}
		upstream.Name = "resize_page"
		upstream.Arguments["width"] = arguments.Width
		upstream.Arguments["height"] = arguments.Height
	case "browser_press_key":
		var arguments struct {
			Key string `json:"key"`
		}
		if decode(&arguments) != nil {
			return browserToolDispatch{}, denied
		}
		switch arguments.Key {
		case "Tab", "Shift+Tab", "Enter", "Space", "Escape", "ArrowUp", "ArrowDown",
			"ArrowLeft", "ArrowRight", "Home", "End":
		default:
			return browserToolDispatch{}, denied
		}
		upstream.Name = "press_key"
		upstream.Arguments["key"] = arguments.Key
		upstream.Arguments["includeSnapshot"] = false
	default:
		return browserToolDispatch{}, denied
	}
	return upstream, nil
}

type browserMCPContent struct {
	IsError           bool                      `json:"isError,omitempty"`
	StructuredContent *browserInspectionContext `json:"structuredContent,omitempty"`
	Content           []struct {
		Type     string `json:"type"`
		Text     string `json:"text,omitempty"`
		Data     string `json:"data,omitempty"`
		MimeType string `json:"mimeType,omitempty"`
	} `json:"content"`
}

// Text is required even after flood truncation leaves an empty item. Image
// items must not include text. Keep the fixed facade's wire schema exact.
func (result browserMCPContent) MarshalJSON() ([]byte, error) {
	content := make([]map[string]string, 0, len(result.Content))
	for _, item := range result.Content {
		if item.Type == "text" {
			content = append(content, map[string]string{"type": "text", "text": item.Text})
		} else {
			content = append(content, map[string]string{"type": item.Type, "mimeType": item.MimeType, "data": item.Data})
		}
	}
	return json.Marshal(struct {
		IsError           bool                      `json:"isError,omitempty"`
		Content           []map[string]string       `json:"content"`
		StructuredContent *browserInspectionContext `json:"structuredContent,omitempty"`
	}{result.IsError, content, result.StructuredContent})
}

// Browser output is ephemeral untrusted App content. Keep text bounded even
// when a page floods its DOM/console. Do not expose upstream saved-file links.
func boundBrowserResult(name string, raw []byte) (browserMCPContent, error) {
	invalid := errors.New("browser observation exceeds its bounds or has unsupported content")
	var result browserMCPContent
	if len(raw) > 3<<20 || json.Unmarshal(raw, &result) != nil || len(result.Content) == 0 || len(result.Content) > 16 {
		return browserMCPContent{}, invalid
	}
	// Never trust upstream page metadata as Factory checkout/authority context.
	result.StructuredContent = nil
	remaining := 32 << 10
	if name == "browser_console" {
		remaining = 8 << 10
	}
	images := 0
	for index := range result.Content {
		item := &result.Content[index]
		switch item.Type {
		case "text":
			if item.Data != "" || item.MimeType != "" {
				return browserMCPContent{}, invalid
			}
			if len(item.Text) > remaining {
				const notice = "\n[Factory truncated this App observation]"
				end := remaining
				if remaining >= len(notice) {
					end -= len(notice)
				}
				for end > 0 && !utf8.ValidString(item.Text[:end]) {
					end--
				}
				item.Text = item.Text[:end]
				if remaining >= len(notice) {
					item.Text += notice
				}
			}
			remaining -= len(item.Text)
		case "image":
			images++
			if name != "browser_screenshot" || images > 1 || item.MimeType != "image/jpeg" ||
				item.Text != "" || len(item.Data) > 2_666_668 {
				return browserMCPContent{}, invalid
			}
			data, err := base64.StdEncoding.DecodeString(item.Data)
			if err != nil || len(data) > 2_000_000 {
				return browserMCPContent{}, invalid
			}
			config, err := jpeg.DecodeConfig(bytes.NewReader(data))
			if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 1280 || config.Height > 720 {
				return browserMCPContent{}, invalid
			}
		default:
			return browserMCPContent{}, invalid
		}
	}
	return result, nil
}
