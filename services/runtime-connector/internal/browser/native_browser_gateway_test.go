package browser

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/open-software-factory/open-software-factory/services/runtime-connector/internal/protocol"
)

const nativeBrowserUnitUID = "01994a7d-0000-7000-8000-000000000004"

func nativeBrowserUnitBootstrap() nativeBrowserBootstrap {
	return nativeBrowserBootstrap{
		Version: 1, AttemptID: "01994a7d-0000-7000-8000-000000000001", Generation: 7,
		Token: strings.Repeat("b", 64),
		Scope: browserRuntimeRequest{
			SessionID: "01994a7d-0000-7000-8000-000000000002",
			TurnID:    "01994a7d-0000-7000-8000-000000000003",
			OwnerID:   strings.Repeat("a", 64), AgentSessionID: "ses_native_browser_unit",
		},
		Apps: []protocol.Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}},
	}
}

func nativeBrowserUnitOperation(t *testing.T, bootstrap nativeBrowserBootstrap, scope browserRuntimeRequest, action string) protocol.Message {
	t.Helper()
	data, err := json.Marshal(scope)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Message{
		Type: "operation-request", OperationID: "01994a7d-0000-7000-8000-000000000005",
		AttemptID: bootstrap.AttemptID, Generation: bootstrap.Generation, Action: action, Data: string(data),
	}
}

func nativeBrowserUnitGateway(t *testing.T) (*nativeBrowserGateway, string, http.Header) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	bootstrap := nativeBrowserUnitBootstrap()
	if err := bootstrap.validate(); err != nil {
		cancel()
		t.Fatal(err)
	}
	gateway := newNativeBrowserGateway(ctx, bootstrap, nativeBrowserUnitUID)
	server := httptest.NewServer(gateway)
	t.Cleanup(func() {
		gateway.mu.Lock()
		gateway.closing = true
		gateway.mu.Unlock()
		cancel()
		server.Close()
		// httptest does not own hijacked sockets. Cancellation closes the
		// admitted socket; wait for its operation worker and handler as well.
		gateway.handlers.Wait()
	})
	return gateway, "ws" + strings.TrimPrefix(server.URL, "http"), http.Header{
		"Authorization":             {"Bearer " + bootstrap.Token},
		"X-Factory-Actor-Uid":       {nativeBrowserUnitUID},
		"X-Factory-Browser-Session": {bootstrap.Scope.SessionID},
	}
}

func nativeBrowserUnitDial(t *testing.T, address string, headers http.Header, protocols []string, status int) *websocket.Conn {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: protocols, HandshakeTimeout: 2 * time.Second}
	connection, response, err := dialer.Dial(address, headers)
	if response != nil {
		defer response.Body.Close()
	}
	if status != http.StatusSwitchingProtocols {
		if connection != nil {
			connection.Close()
		}
		if err == nil || response == nil || response.StatusCode != status {
			t.Fatalf("WebSocket rejection: status=%v err=%v, want %d", response, err, status)
		}
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { connection.Close() })
	if connection.Subprotocol() != nativeBrowserProtocol || response.Header.Get("X-Factory-Actor-Uid") != nativeBrowserUnitUID {
		t.Fatal("admitted socket lost its protocol or Actor identity")
	}
	// No operation, including renewal, is sent until the Actor proves its
	// identity in the protocol's mandatory first frame.
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	var hello struct {
		Type      string `json:"type"`
		ActorUID  string `json:"actorUID"`
		SessionID string `json:"sessionID"`
	}
	if err := connection.ReadJSON(&hello); err != nil {
		t.Fatal("gateway did not send its initial Browser identity", err)
	}
	if hello.Type != "browser-connected" || hello.ActorUID != nativeBrowserUnitUID ||
		hello.SessionID != headers.Get("X-Factory-Browser-Session") {
		t.Fatal("first gateway frame did not confirm the admitted Actor and Browser session")
	}
	return connection
}

func TestNativeBrowserGatewayUnitRejectedAdmissionDoesNotConsumeConnection(t *testing.T) {
	for _, variant := range []string{
		"uid", "token", "session", "origin", "path", "query", "protocol", "missing-protocol",
		"duplicate-authorization", "duplicate-uid", "duplicate-session",
	} {
		t.Run(variant, func(t *testing.T) {
			gateway, address, headers := nativeBrowserUnitGateway(t)
			invalid := headers.Clone()
			path := nativeBrowserPath
			protocols := []string{nativeBrowserProtocol}
			switch variant {
			case "uid":
				invalid.Set("X-Factory-Actor-Uid", "01994a7d-0000-7000-8000-000000000099")
			case "token":
				invalid.Set("Authorization", "Bearer "+strings.Repeat("c", 64))
			case "session":
				invalid.Set("X-Factory-Browser-Session", "01994a7d-0000-7000-8000-000000000099")
			case "origin":
				invalid.Set("Origin", "https://foreign.test")
			case "path":
				path += "/other"
			case "query":
				path += "?credential=forbidden"
			case "protocol":
				protocols = []string{"wrong-protocol"}
			case "missing-protocol":
				protocols = nil
			case "duplicate-authorization":
				invalid.Add("Authorization", invalid.Get("Authorization"))
			case "duplicate-uid":
				invalid.Add("X-Factory-Actor-Uid", nativeBrowserUnitUID)
			case "duplicate-session":
				invalid.Add("X-Factory-Browser-Session", gateway.bootstrap.Scope.SessionID)
			}
			nativeBrowserUnitDial(t, address+path, invalid, protocols, http.StatusForbidden)
			if gateway.connected.Load() {
				t.Fatal("rejected admission consumed the only control connection")
			}
			connection := nativeBrowserUnitDial(t, address+nativeBrowserPath, headers,
				[]string{nativeBrowserProtocol}, http.StatusSwitchingProtocols)
			// A real renewal exchange proves the valid connection reaches the
			// gateway loop without starting a host worker or writing /factory.
			scope := gateway.bootstrap.Scope
			scope.ExpiresAt = time.Now().Add(20 * time.Second)
			operation := nativeBrowserUnitOperation(t, gateway.bootstrap, scope, "browser-renew")
			if err := connection.WriteJSON(nativeBrowserFrame{Type: "operation-request", Operation: &operation}); err != nil {
				t.Fatal(err)
			}
			_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
			var frame nativeBrowserFrame
			if err := connection.ReadJSON(&frame); err != nil {
				t.Fatal(err)
			}
			if frame.Type != "operation-response" || frame.Operation == nil ||
				frame.Operation.OperationID != operation.OperationID || frame.Operation.Error != "" {
				t.Fatalf("fresh renewal was not acknowledged: %+v", frame.Operation)
			}
		})
	}
}

func TestNativeBrowserGatewayUnitOnlyOneConnectionIncludingAfterDisconnect(t *testing.T) {
	gateway, address, headers := nativeBrowserUnitGateway(t)
	connection := nativeBrowserUnitDial(t, address+nativeBrowserPath, headers,
		[]string{nativeBrowserProtocol}, http.StatusSwitchingProtocols)
	nativeBrowserUnitDial(t, address+nativeBrowserPath, headers, []string{nativeBrowserProtocol}, http.StatusConflict)
	connection.Close()
	gateway.handlers.Wait()
	nativeBrowserUnitDial(t, address+nativeBrowserPath, headers, []string{nativeBrowserProtocol}, http.StatusConflict)
}
