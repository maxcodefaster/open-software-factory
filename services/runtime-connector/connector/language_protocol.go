package connector

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

const maxLanguageBytes = 1 << 20

// The websocket carries one JSON-RPC message per frame. Only the process-facing
// side uses LSP's Content-Length framing. Never interpret document text as a URI.
func readLanguageMessage(reader *bufio.Reader) ([]byte, error) {
	length := -1
	headers := 0
	for {
		data, err := reader.ReadSlice('\n')
		line := string(data)
		headers += len(data)
		if err != nil || headers > 8<<10 {
			return nil, errors.New("invalid language server headers")
		}
		if line == "\r\n" {
			break
		}
		name, value, found := strings.Cut(strings.TrimSpace(line), ":")
		if found && strings.EqualFold(name, "Content-Length") {
			if length != -1 {
				return nil, errors.New("duplicate language message length")
			}
			length, err = strconv.Atoi(strings.TrimSpace(value))
			if err != nil {
				return nil, errors.New("invalid language message length")
			}
		}
	}
	if length < 1 || length > maxLanguageBytes {
		return nil, errors.New("language message size is invalid")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(reader, body); err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, errors.New("language message is not JSON")
	}
	return body, nil
}

func writeLanguageMessage(writer io.Writer, value any) error {
	body, err := json.Marshal(value)
	if err != nil || len(body) > maxLanguageBytes {
		return errors.New("language message size is invalid")
	}
	_, err = fmt.Fprintf(writer, "Content-Length: %d\r\n\r\n%s", len(body), body)
	return err
}

type languageURIs struct {
	workspaceID string
	root        string
}

func (scope languageURIs) toRuntime(value string) (string, error) {
	uri, err := url.Parse(value)
	if err != nil || uri.Scheme != "factory-workspace" || uri.Host != scope.workspaceID || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" || !filepath.IsAbs(uri.Path) || filepath.Clean(uri.Path) != uri.Path {
		return "", errors.New("language document belongs to another Workspace")
	}
	return (&url.URL{Scheme: "file", Path: filepath.Join(scope.root, uri.Path)}).String(), nil
}

func (scope languageURIs) toEditor(value string) (string, error) {
	uri, err := url.Parse(value)
	if err != nil || uri.Scheme != "file" || uri.Host != "" || uri.User != nil || uri.RawQuery != "" || uri.Fragment != "" {
		return "", errors.New("language document is outside this Workspace")
	}
	relative, err := filepath.Rel(scope.root, uri.Path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("language document is outside this Workspace")
	}
	if relative == "." {
		relative = ""
	}
	return (&url.URL{Scheme: "factory-workspace", Host: scope.workspaceID, Path: "/" + filepath.ToSlash(relative)}).String(), nil
}

func mapLanguageURIs(value any, convert func(string) (string, error), filterExternal bool) (any, error) {
	switch value := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, child := range value {
			if key == "uri" || key == "targetUri" || key == "rootUri" || key == "scopeUri" {
				if text, ok := child.(string); ok {
					mapped, err := convert(text)
					if err != nil {
						return nil, err
					}
					result[key] = mapped
					continue
				}
			}
			mapped, err := mapLanguageURIs(child, convert, filterExternal)
			if err != nil {
				return nil, err
			}
			result[key] = mapped
		}
		return result, nil
	case []any:
		result := make([]any, 0, len(value))
		for _, child := range value {
			mapped, err := mapLanguageURIs(child, convert, filterExternal)
			if err != nil {
				if filterExternal {
					continue // External library locations cannot become backend-local file:// reads.
				}
				return nil, err
			}
			result = append(result, mapped)
		}
		return result, nil
	default:
		return value, nil
	}
}

func allowedLanguageMethod(method string) bool {
	switch method {
	case "initialize", "initialized", "shutdown", "exit", "$/cancelRequest",
		"textDocument/didOpen", "textDocument/didChange", "textDocument/didSave", "textDocument/didClose",
		"textDocument/completion", "completionItem/resolve", "textDocument/hover",
		"textDocument/definition", "textDocument/references", "textDocument/signatureHelp":
		return true
	}
	return false
}
