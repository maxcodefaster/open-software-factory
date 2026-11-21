package connector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Reexec the tested worker inside the unchanged browser-tools image. Its
// Chromium/MCP subprocess still receives RunBrowserWorker's restricted env.
func TestNativeBrowserWorkerProcess(t *testing.T) {
	if os.Getenv("FACTORY_NATIVE_BROWSER_WORKER_PROCESS") != "1" {
		t.Skip("native worker subprocess only")
	}
	if err := RunBrowserWorker(context.Background()); err != nil {
		t.Fatal(err)
	}
	os.Exit(0)
}

func TestBrowserWorkerNativeRetainedScreenshots(t *testing.T) {
	directory := os.Getenv("FACTORY_BROWSER_RENDERING_NATIVE_RETAINED")
	if directory == "" {
		t.Skip("requires the three owned review JPEGs extracted from the verified archive")
	}
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || len(strings.TrimSpace(string(uid))) != 36 || os.Geteuid() != 0 {
		t.Fatal("owned Actor identity and private namespace root required")
	}
	for index := 0; index < 3; index++ {
		data, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("review-archived-%d.jpg", index)))
		if err != nil {
			t.Fatal(err)
		}
		if jpegFirstScanComponents(data) != 1 {
			t.Fatal("original review JPEG does not have the observed fast scan layout")
		}
		var output bytes.Buffer
		writer := &browserScreenshotOutput{writer: &output}
		if _, err := writer.Write(append(browserScreenshotReply(t, data), '\n')); err != nil {
			t.Fatal(err)
		}
		var reply struct {
			Result struct {
				Content []struct{ Type, Data string }
			}
		}
		if err := json.Unmarshal(output.Bytes(), &reply); err != nil {
			t.Fatal(err)
		}
		normalized, err := base64.StdEncoding.DecodeString(reply.Result.Content[1].Data)
		if err != nil || jpegFirstScanComponents(normalized) != 3 {
			t.Fatal("retained screenshot normalization failed", err)
		}
		before, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		after, err := jpeg.Decode(bytes.NewReader(normalized))
		if err != nil || before.Bounds() != after.Bounds() {
			t.Fatal("retained screenshot dimensions changed", err)
		}
		bad, samples := 0, 0
		for y := 8; y < before.Bounds().Dy(); y += 8 {
			for x := 8; x < before.Bounds().Dx(); x += 8 {
				r1, g1, b1, _ := before.At(x, y).RGBA()
				r2, g2, b2, _ := after.At(x, y).RGBA()
				samples++
				if abs(int(r1>>8)-int(r2>>8)) > 20 || abs(int(g1>>8)-int(g2>>8)) > 20 || abs(int(b1>>8)-int(b2>>8)) > 20 {
					bad++
				}
			}
		}
		if bad > samples/100 {
			t.Fatalf("retained screenshot changed too many pixels: %d/%d", bad, samples)
		}
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("review-normalized-%d.jpg", index)), normalized, 0600); err != nil {
			t.Fatal(err)
		}
		t.Logf("retained JPEG %d: interleaved scan, preserved %dx%d, changed_pixels=%d/%d",
			index, after.Bounds().Dx(), after.Bounds().Dy(), bad, samples)
	}
}

// Explicit native lane: run this CGO=0 test binary inside an owned Actor's
// existing RootlessKit namespace. No model calls, Project or retained browser.
func TestBrowserWorkerNativeScreenshotPixels(t *testing.T) {
	image := os.Getenv("FACTORY_BROWSER_RENDERING_NATIVE_IMAGE")
	if image == "" {
		t.Skip("requires an explicitly owned native screenshot fixture")
	}
	owner := os.Getenv("FACTORY_BROWSER_RENDERING_NATIVE_OWNER")
	uid, err := os.ReadFile("/run/ate/identity/uid")
	if err != nil || len(strings.TrimSpace(string(uid))) != 36 || os.Geteuid() != 0 ||
		!identityPattern.MatchString(owner) || !browserImagePattern.MatchString(image) {
		t.Fatal("owned Actor identity, private namespace root and immutable image required")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	// Container UID 1000 must traverse its public configuration and test binary.
	if err := os.Chmod(directory, 0755); err != nil {
		t.Fatal(err)
	}
	for _, child := range []string{"config", "socket", "socket/config"} {
		if err := os.Mkdir(filepath.Join(directory, child), 0755); err != nil {
			t.Fatal(err)
		}
	}
	channels := []Channel{{Name: "app", Kind: "app", Target: "http://127.0.0.1:3000"}}
	apps, _ := json.Marshal(channels)
	if err := os.WriteFile(filepath.Join(directory, "config/apps.json"), apps, 0444); err != nil {
		t.Fatal(err)
	}
	scope := browserRuntimeRequest{SessionID: owner, ExpiresAt: time.Now().Add(25 * time.Second)}
	if err := writeBrowserAuthority(directory, scope); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(directory, "socket/app.sock"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(directory, "socket/app.sock"), 0666); err != nil {
		t.Fatal(err)
	}
	// Large flat regions catch row/stride corruption without font snapshots.
	page := `<!doctype html><style>html,body{margin:0;background:rgb(240,240,240)}div{height:180px}.red{background:rgb(220,30,30)}.blue{background:rgb(30,30,220)}</style><div></div><div class=red></div><div class=blue></div><div></div>`
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(page))
	}), ReadHeaderTimeout: time.Second}
	go server.Serve(listener)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	name := "factory-browser-rendering-" + owner
	command := func(args ...string) []byte {
		t.Helper()
		process := exec.CommandContext(ctx, "docker", args...)
		var stderr bytes.Buffer
		process.Stderr = &stderr
		out, err := process.Output()
		if err != nil {
			t.Fatalf("owned screenshot fixture command failed: %v: %s", err, stderr.String())
		}
		return bytes.TrimSpace(out)
	}
	id := string(command("create", "--pull=never", "--name", name,
		"--label", "factory.browser-rendering="+owner,
		"--network", "none", "--user", "1000:1000", "--read-only", "--cap-drop", "ALL",
		"--security-opt", "no-new-privileges", "--pids-limit", "256", "--memory", "1408m", "--cpus", "1",
		"--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--interactive",
		"--mount", "type=bind,src="+directory+"/socket,dst=/factory/browser,readonly",
		"--mount", "type=bind,src="+directory+"/config,dst=/factory/browser/config,readonly",
		"--mount", "type=bind,src="+executable+",dst=/factory-native-test,readonly",
		"--env", "FACTORY_NATIVE_BROWSER_WORKER_PROCESS=1",
		"--entrypoint", "/factory-native-test", image, "-test.run=^TestNativeBrowserWorkerProcess$"))
	if !browserContainerPattern.MatchString(id) {
		t.Fatal("missing exact owned container ID")
	}
	defer func() {
		// Cleanup uses a fresh context even after a failed or expired screenshot.
		cleanup, end := context.WithTimeout(context.Background(), 10*time.Second)
		defer end()
		out, err := exec.CommandContext(cleanup, "docker", "inspect", "--format",
			`{{index .Config.Labels "factory.browser-rendering"}}`, id).Output()
		if err != nil || strings.TrimSpace(string(out)) != owner {
			t.Error("owned screenshot cleanup identity changed")
			return
		}
		if err := exec.CommandContext(cleanup, "docker", "rm", "--force", id).Run(); err != nil {
			t.Error("owned screenshot cleanup unconfirmed")
		}
	}()
	worker := exec.CommandContext(ctx, "docker", "start", "--attach", "--interactive", id)
	input, _ := worker.StdinPipe()
	output, _ := worker.StdoutPipe()
	var stderr bytes.Buffer
	worker.Stderr = &stderr
	if err := worker.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { input.Close(); _ = worker.Wait() }()
	scanner := bufio.NewScanner(output)
	scanner.Buffer(make([]byte, 65536), 3<<20)
	sequence := 0
	rpc := func(method string, params any) json.RawMessage {
		t.Helper()
		sequence++
		_ = json.NewEncoder(input).Encode(map[string]any{
			"jsonrpc": "2.0", "id": sequence, "method": method, "params": params,
		})
		for scanner.Scan() {
			var reply browserMCPReply
			if json.Unmarshal(scanner.Bytes(), &reply) != nil || reply.ID != sequence {
				continue
			}
			if reply.Error != nil {
				t.Fatalf("native MCP failed: %s", scanner.Text())
			}
			var content struct {
				IsError bool `json:"isError"`
			}
			if json.Unmarshal(reply.Result, &content) != nil || content.IsError {
				t.Fatalf("native MCP tool failed: %s", reply.Result)
			}
			return reply.Result
		}
		t.Fatalf("native MCP ended before screenshot: %s", stderr.String())
		return nil
	}
	rpc("initialize", map[string]any{
		"protocolVersion": "2025-06-18", "capabilities": map[string]any{},
		"clientInfo": map[string]string{"name": "factory-native-pixel-proof", "version": "1"},
	})
	_ = json.NewEncoder(input).Encode(map[string]string{"jsonrpc": "2.0", "method": "notifications/initialized"})
	runtime := &browserRuntime{}
	invoke := func(name string, args any) json.RawMessage {
		t.Helper()
		encoded, _ := json.Marshal(args)
		dispatch, err := resolveBrowserTool(channels, runtime.pageID, browserToolCall{Name: name, Arguments: encoded})
		if err != nil {
			t.Fatal(err)
		}
		result := rpc("tools/call", map[string]any{"name": dispatch.Name, "arguments": dispatch.Arguments})
		if name == "browser_open" {
			if err := runtime.selectDeclaredPage(result, dispatch.App); err != nil {
				t.Fatalf("native App navigation failed: %v: %s", err, result)
			}
		}
		return result
	}
	invoke("browser_open", map[string]string{"app": "app"})
	rpc("tools/call", map[string]any{"name": "screencast_start", "arguments": map[string]any{
		"pageId": runtime.pageID, "filePath": browserRecordingPath,
	}})
	for _, width := range []int{1280, 390} {
		if width != 1280 {
			invoke("browser_resize", map[string]int{"width": width, "height": 720})
		}
		for capture := 0; capture < 2; capture++ {
			result := invoke("browser_screenshot", map[string]any{})
			var screenshot struct {
				Content []struct{ Type, Data, MimeType string }
			}
			if err := json.Unmarshal(result, &screenshot); err != nil {
				t.Fatal(err)
			}
			var data []byte
			for _, content := range screenshot.Content {
				if content.Type == "image" {
					data, err = base64.StdEncoding.DecodeString(content.Data)
				}
			}
			if err != nil || len(data) == 0 {
				t.Fatalf("native screenshot missing: %s", result)
			}
			// The model image reader renders Chromium's fast, non-interleaved
			// baseline JPEG as green horizontal stripes even though Go and
			// ImageIO decode its pixels correctly. Keep the portable scan layout.
			if components := jpegFirstScanComponents(data); components != 3 {
				t.Errorf("model-readable JPEG needs one interleaved color scan, got %d components", components)
			}
			decoded, err := jpeg.Decode(bytes.NewReader(data))
			if err != nil || decoded.Bounds().Dx() != width || decoded.Bounds().Dy() != 720 {
				t.Fatalf("native screenshot dimensions or JPEG invalid: %v", err)
			}
			bad, samples := 0, 0
			for y := 20; y < 700; y += 8 {
				expected := [3]int{240, 240, 240}
				if y >= 180 && y < 360 {
					expected = [3]int{220, 30, 30}
				} else if y >= 360 && y < 540 {
					expected = [3]int{30, 30, 220}
				}
				for x := 20; x < width-20; x += 8 {
					r, g, b, _ := decoded.At(x, y).RGBA()
					samples++
					if abs(int(r>>8)-expected[0]) > 20 || abs(int(g>>8)-expected[1]) > 20 || abs(int(b>>8)-expected[2]) > 20 {
						bad++
					}
				}
			}
			if evidence := os.Getenv("FACTORY_BROWSER_RENDERING_NATIVE_RESULTS"); evidence != "" {
				path := filepath.Join(evidence, fmt.Sprintf("%s-%d-%d.jpg", owner, width, capture))
				if err := os.WriteFile(path, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			t.Logf("native JPEG width=%d capture=%d mismatched_pixels=%d/%d", width, capture, bad, samples)
			if bad > samples/100 {
				t.Errorf("native screenshot has corrupted rows: %d/%d pixel samples differ", bad, samples)
			}
		}
	}
	rpc("tools/call", map[string]any{"name": "screencast_stop", "arguments": map[string]any{"pageId": runtime.pageID}})
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func jpegFirstScanComponents(data []byte) int {
	if len(data) < 2 || data[0] != 0xff || data[1] != 0xd8 {
		return 0
	}
	for offset := 2; offset+4 < len(data); {
		if data[offset] != 0xff {
			return 0
		}
		marker := data[offset+1]
		length := int(data[offset+2])<<8 | int(data[offset+3])
		if length < 2 || offset+2+length > len(data) {
			return 0
		}
		if marker == 0xda {
			return int(data[offset+4])
		}
		offset += 2 + length
	}
	return 0
}
