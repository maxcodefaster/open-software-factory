package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestChildHTTPAppAuthorization(t *testing.T) {
	for _, test := range []struct {
		name, kind, authorization string
		invalid                   bool
	}{
		{"app", "app", "Bearer browser-app", false},
		{"ordinary-app-authorization-stays-stripped", "app", "", false},
		{"agent-denied", "agent", "Bearer browser-app", true},
		{"source-denied", "source", "Bearer browser-app", true},
		{"ide-denied", "ide", "Bearer browser-app", true},
		{"byte-limit", "app", "Bearer " + strings.Repeat("x", (16<<10)-7), false},
		{"byte-limit-exceeded", "app", "Bearer " + strings.Repeat("x", (16<<10)-6), true},
		{"multibyte-limit", "app", "Basic " + strings.Repeat("é", ((16<<10)-6)/2), false},
		{"multibyte-limit-exceeded", "app", "Basic " + strings.Repeat("é", 8<<10), true},
		{"CRLF", "app", "Bearer browser-app\r\nX-Injected: owned", true},
		{"NUL", "app", "Bearer browser-app\x00", true},
		{"tab", "app", "Bearer browser\tapp", true},
		{"control", "app", "Bearer browser-app\x1f", true},
		{"DEL", "app", "Bearer browser-app\x7f", true},
		{"non-byte", "app", "Bearer browser-app\u0100", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			checkChildHTTPAppAuthorization(t, test.kind, test.authorization, test.invalid)
		})
	}
}

func checkChildHTTPAppAuthorization(t *testing.T, kind, authorization string, invalid bool) {
	t.Helper()
	observed := make(chan http.Header, 1)
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed <- r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer application.Close()
	messages := make(chan Message, 4)
	upgrader := websocket.Upgrader{}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				return
			}
			messages <- message
			if message.Type == "stream-end" || message.Type == "stream-error" {
				return
			}
		}
	}))
	defer control.Close()
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(control.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	runtime := childRuntime{
		assignment: Assignment{Channels: []Channel{{Name: "app", Kind: kind, Target: application.URL}}},
		control:    newControlConnection(connection),
		httpClient: application.Client(),
	}
	var message Message
	wire, err := json.Marshal(map[string]any{
		"type": "http-request", "streamId": "owned", "channel": "app", "method": "GET", "path": "/",
		"headers":          map[string]string{"cookie": "app_session=owned", "authorization": "Bearer must-not-forward"},
		"appAuthorization": authorization,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wire, &message); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	runtime.handleHTTPRequest(ctx, message)
	select {
	case response := <-messages:
		if invalid {
			if response.Type != "stream-error" || response.Error != "invalid App authorization" {
				t.Error("invalid App authorization did not fail before dispatch")
			}
			select {
			case <-observed:
				t.Error("invalid App authorization reached an upstream endpoint")
			default:
			}
			return
		}
		if response.Type != "http-response" || response.Status != http.StatusNoContent {
			t.Error("App authorization response failed")
		}
	case <-ctx.Done():
		t.Fatal("App authorization response did not settle")
	}
	select {
	case headers := <-observed:
		if headers.Get("Authorization") != authorization || headers.Get("Cookie") != "app_session=owned" {
			t.Error("App-only authorization or Cookie did not reach the declared App")
		}
	case <-ctx.Done():
		t.Fatal("App authorization request did not reach its declared target")
	}
}

func TestChildHTTPResponseCookies(t *testing.T) {
	atCountLimit := make([]string, 128)
	for index := range atCountLimit {
		atCountLimit[index] = fmt.Sprintf("session%d=owned", index)
	}
	for _, test := range []struct {
		name    string
		cookies []string
		invalid bool
	}{
		{"absent", nil, false},
		{"separate-with-expiry", []string{
			"session=owned; Path=/private; HttpOnly",
			"theme=light; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
			"session=; Max-Age=0; Path=/old",
		}, false},
		{"count-limit", atCountLimit, false},
		{"count-exceeded", append(append([]string{}, atCountLimit...), "extra=owned"), true},
		{"byte-limit", []string{"large=" + strings.Repeat("x", (64<<10)-6)}, false},
		{"byte-limit-exceeded", []string{"large=" + strings.Repeat("x", (64<<10)-5)}, true},
		{"aggregate-byte-limit", []string{
			"first=" + strings.Repeat("x", (32<<10)-6),
			"other=" + strings.Repeat("x", (32<<10)-6),
		}, false},
		{"aggregate-byte-limit-exceeded", []string{
			"first=" + strings.Repeat("x", (32<<10)-6),
			"other=" + strings.Repeat("x", (32<<10)-5),
		}, true},
		{"multibyte-limit", []string{"large=" + strings.Repeat("é", ((64<<10)-6)/2)}, false},
		{"multibyte-limit-exceeded", []string{"large=" + strings.Repeat("é", (64<<10)/2)}, true},
		{"empty-header", []string{""}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			checkChildHTTPResponseCookies(t, test.cookies, test.invalid)
		})
	}
}

func checkChildHTTPResponseCookies(t *testing.T, cookies []string, invalid bool) {
	t.Helper()
	requestCookies := make(chan string, 1)
	application := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCookies <- r.Header.Get("Cookie")
		for _, cookie := range cookies {
			w.Header().Add("Set-Cookie", cookie)
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = fmt.Fprint(w, "App")
	}))
	defer application.Close()
	result := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer connection.Close()
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		// Decode the wire independently of Message so the response-only cookie
		// list, rather than a flattened Set-Cookie header, is the contract.
		var response struct {
			Type    string            `json:"type"`
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
			Cookies []string          `json:"cookies"`
			Error   string            `json:"error"`
		}
		if err := connection.ReadJSON(&response); err != nil {
			result <- err
			return
		}
		if invalid {
			if response.Type != "stream-error" || response.Error != "invalid channel response cookies" ||
				len(response.Cookies) != 0 || len(response.Headers) != 0 {
				result <- fmt.Errorf("invalid cookies did not fail before response headers: %s", response.Type)
			} else {
				result <- nil
			}
			return
		}
		if response.Type != "http-response" || response.Status != http.StatusOK ||
			response.Headers["Content-Type"] != "text/plain" || !reflect.DeepEqual(response.Cookies, cookies) {
			result <- fmt.Errorf("HTTP response lost separate cookies: %#v", response)
			return
		}
		for name := range response.Headers {
			if strings.EqualFold(name, "Set-Cookie") {
				result <- fmt.Errorf("HTTP response duplicated a flattened cookie")
				return
			}
		}
		for {
			var message Message
			if err := connection.ReadJSON(&message); err != nil {
				result <- err
				return
			}
			if message.Type == "stream-end" || message.Type == "stream-error" {
				if message.Type == "stream-error" {
					result <- fmt.Errorf("HTTP response failed: %s", message.Error)
				} else {
					result <- nil
				}
				return
			}
		}
	}))
	defer control.Close()
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(control.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	runtime := childRuntime{
		assignment: Assignment{Channels: []Channel{{Name: "app", Kind: "app", Target: application.URL}}},
		control:    newControlConnection(connection),
		httpClient: application.Client(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	runtime.handleHTTPRequest(ctx, Message{
		StreamID: "owned", Channel: "app", Method: http.MethodGet, Path: "/",
		Cookies: []string{"response_only=must-not-forward"},
	})
	select {
	case cookie := <-requestCookies:
		if cookie != "" {
			t.Error("response-only cookies were forwarded as request credentials")
		}
	default:
		t.Error("App request did not reach its declared target")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("HTTP cookie response did not settle")
	}
}
