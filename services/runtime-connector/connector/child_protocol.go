package connector

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// The Hub removed Factory credentials, or the native Browser owner admitted
// isolated App credentials. Neither changes the dial target.
// Never source Authorization from generic Headers or Child/Parent/Agent credentials.
func applyAppRequestHeaders(channel Channel, message Message, headers http.Header) (string, error) {
	host, err := appProxyHost(channel, message.Headers)
	if err != nil {
		return "", err
	}
	if cookie := message.Headers["cookie"]; cookie != "" {
		headers.Set("Cookie", cookie)
	}
	if message.AppAuthorization != "" {
		headers.Set("Authorization", message.AppAuthorization)
	}
	return host, nil
}

// Only the declared Agent loopback channel receives the assignment's generation capability.
// Browser and App headers can neither choose nor override OpenCode server credentials.
func authorizeAgentRequest(request *http.Request, channel Channel, assignment Assignment) {
	if channel.Kind != "agent" {
		return
	}
	for _, process := range assignment.Processes {
		if process.Name != channel.Name {
			continue
		}
		if password := process.Env["OPENCODE_PASSWORD"]; password != "" {
			request.SetBasicAuth("opencode", password)
		}
		return
	}
}

func channelURL(channel Channel, path string, websocketTarget bool) (string, error) {
	if channel.Kind == "ide" || validateTarget(channel.Target) != nil {
		return "", errors.New("channel has no HTTP endpoint")
	}
	if path == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", errors.New("invalid channel path")
	}
	reference, err := url.Parse(path)
	if err != nil || reference.IsAbs() || reference.Host != "" {
		return "", errors.New("invalid channel path")
	}
	base, _ := url.Parse(channel.Target)
	base.Path = reference.Path
	base.RawPath = reference.RawPath
	base.RawQuery = reference.RawQuery
	if websocketTarget {
		base.Scheme = "ws"
	}
	return base.String(), nil
}

func copyRequestHeaders(destination http.Header, source map[string]string) {
	for name, value := range source {
		if allowedRequestHeader(name) {
			destination.Set(name, value)
		}
	}
}

func allowedRequestHeader(name string) bool {
	switch strings.ToLower(name) {
	case "authorization", "cookie", "connection", "host", "proxy-authorization", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions", "upgrade":
		return false
	default:
		return true
	}
}

func validTheiaConnectionToken(token string) bool {
	if token == "" || len(token) > 256 {
		return false
	}
	for _, character := range token {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '.' || character == '_' || character == '~' || character == '-' {
			continue
		}
		return false
	}
	return true
}
