package connector

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNativeSetupContinuesOnlyConfirmedDeferredCommandsAndReportsReconnect(t *testing.T) {
	for _, scenario := range []string{"success", "failed", "incomplete", "lost-reply", "cancelled", "done"} {
		t.Run(scenario, func(t *testing.T) {
			directory := nativeNetworkFixture(t)
			script := `#!/bin/sh
printf '%s\n' "$*" >> "$NATIVE_NETWORK_FIXTURE/cli.log"
case " $* " in
  *' --skip-non-blocking-commands '*)
    if [ "$NATIVE_NETWORK_SCENARIO" = done ]; then
      printf '{"outcome":"success","result":"done"}\n'
    else
      printf '{"outcome":"success","result":"skipNonBlocking"}\n'
    fi ;;
  *)
    case "$NATIVE_NETWORK_SCENARIO" in
      cancelled)
        printf '%s' "$$" > "$NATIVE_NETWORK_FIXTURE/setup-pid"
        exec /bin/sleep 30 ;;
      success) printf '{"outcome":"success","result":"done"}\n' ;;
      failed) printf '{"outcome":"error","description":"postCreateCommand failed; PRIVATE_TOKEN=private-value"}\n'; exit 1 ;;
      incomplete) printf '{"outcome":"success"}\n' ;;
      lost-reply) exit 1 ;;
    esac ;;
esac
`
			if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("NATIVE_NETWORK_SCENARIO", scenario)
			assignment := validAssignment()
			assignment.RuntimeEnvironment = map[string]string{"PRIVATE_TOKEN": "private-value"}
			assignment.nativeSource = http.NotFoundHandler()
			result := devcontainerResult{ContainerID: strings.Repeat("b", 64)}
			pending, err := runNativeLifecycle(t.Context(), assignment, result, true)
			if err != nil || pending != (scenario != "done") {
				t.Fatalf("unexpected official CLI boundary result: pending=%v error=%v", pending, err)
			}
			result.lifecyclePending = pending
			setup := startNativeSetup(t.Context(), assignment, result, nil)
			defer setup.stop()
			if scenario == "done" {
				if setup != nil {
					t.Fatal("completed lifecycle dispatched a second postAttachCommand")
				}
				return
			}
			assignment.nativeSetup = setup
			if scenario == "cancelled" {
				var pid int
				for deadline := time.Now().Add(2 * time.Second); ; {
					raw, _ := os.ReadFile(filepath.Join(directory, "setup-pid"))
					pid, _ = strconv.Atoi(string(raw))
					if pid > 0 {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("optional setup did not start")
					}
					time.Sleep(time.Millisecond)
				}
				// Exercise the real Source checkpoint handler, not cancellation
				// alone: Docker drain cannot ACK with an owned CLI still alive.
				reply := handleParentOperation(t.Context(), assignment, Message{Action: "source-drain", OperationID: "owned-checkpoint"})
				if reply.Error != "" || syscall.Kill(pid, 0) != syscall.ESRCH {
					t.Fatalf("Source drain did not join optional setup: %s", reply.Error)
				}
			}
			select {
			case <-setup.done:
			case <-time.After(2 * time.Second):
				t.Fatal("optional setup did not settle")
			}
			messages := make(chan Message, 8)
			upgrader := websocket.Upgrader{Subprotocols: []string{ConnectorProtocol}}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				peer, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer peer.Close()
				for {
					var message Message
					if peer.ReadJSON(&message) != nil {
						return
					}
					messages <- message
				}
			}))
			defer server.Close()
			assignment.ControlURL = "ws" + strings.TrimPrefix(server.URL, "http")
			control, err := dialControl(t.Context(), assignment, "parent", "owned-parent-token")
			if err != nil {
				t.Fatal(err)
			}
			control.close()
			if err := announceChildStarted(t.Context(), assignment, "owned-parent-token", &control); err != nil {
				t.Fatal(err)
			}
			defer control.close()
			state := waitForMessage(t, messages, func(m Message) bool { return m.Type == "process-state" })
			wantState, wantExit := "failed", 1
			switch scenario {
			case "success":
				wantState, wantExit = "stopped", 0
			case "cancelled":
				wantState, wantExit = "stopped", 130
			}
			if state.Process != "setup" || state.ProcessState != wantState || state.StartedAt == "" ||
				state.ExitCode == nil || *state.ExitCode != wantExit {
				t.Fatalf("reconnect lost the actual setup result: %#v", state)
			}
			output := waitForMessage(t, messages, func(m Message) bool { return m.Type == "process-output" })
			text, err := base64.StdEncoding.DecodeString(output.Data)
			if err != nil || len(text) == 0 || strings.Contains(string(text), "private-value") {
				t.Fatal("setup output was missing or exposed a credential")
			}
			waitForMessage(t, messages, func(m Message) bool { return m.Phase == "child-started" })
			trace, _ := os.ReadFile(filepath.Join(directory, "cli.log"))
			if strings.Count(string(trace), "run-user-commands ") != 2 ||
				strings.Count(string(trace), "--skip-non-blocking-commands") != 1 {
				t.Fatalf("setup or reconnect repeated commands: %s", trace)
			}
		})
	}
}

func TestNativeDevelopmentWaitForStillBlocksRequiredLifecycle(t *testing.T) {
	directory := nativeNetworkFixture(t)
	script := "#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$NATIVE_NETWORK_FIXTURE/required-pid\"\nexec /bin/sleep 30\n"
	if err := os.WriteFile(filepath.Join(directory, "devcontainer"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		pending, err := runNativeLifecycle(ctx, validAssignment(), devcontainerResult{ContainerID: strings.Repeat("b", 64)}, true)
		if pending {
			t.Error("required waitFor commands were treated as optional")
		}
		done <- err
	}()
	var pid int
	for deadline := time.Now().Add(2 * time.Second); ; {
		raw, _ := os.ReadFile(filepath.Join(directory, "required-pid"))
		pid, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
		if pid > 0 {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("required lifecycle was not entered: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("fixture did not enter the required lifecycle")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("required lifecycle returned before waitFor completed: %v", err)
	default:
	}
	cancel()
	if err := <-done; err == nil || ctx.Err() == nil || syscall.Kill(pid, 0) != syscall.ESRCH {
		t.Fatal("required lifecycle cancellation did not join its CLI")
	}
}

func TestNativeSetupDoesNotDispatchAfterStop(t *testing.T) {
	directory := nativeNetworkFixture(t)
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(t.Context())
		control := &controlConnection{sourceDrain: make(chan struct{})}
		if cancelled {
			cancel()
		} else {
			close(control.sourceDrain)
		}
		setup := startNativeSetup(ctx, validAssignment(), devcontainerResult{lifecyclePending: true}, control)
		cancel()
		if setup != nil {
			setup.stop()
			t.Fatal("Stop admitted a deferred lifecycle invocation")
		}
	}
	if _, err := os.Stat(filepath.Join(directory, "cli.log")); !os.IsNotExist(err) {
		t.Fatal("Stop dispatched a Project lifecycle command")
	}
}
