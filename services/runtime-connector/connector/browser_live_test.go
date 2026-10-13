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
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// This helper runs only inside the disposable proxy fixture container. The real
// browser runs in a different, network=none container and shares only this socket.
func TestBrowserMCPProxyFixture(t *testing.T) {
	if os.Getenv("FACTORY_BROWSER_PROXY_FIXTURE") != "1" {
		t.Skip("internal live-browser fixture")
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	primaryIP := ""
	for _, address := range addresses {
		if value, ok := address.(*net.IPNet); ok && value.IP.To4() != nil && value.IP.IsPrivate() {
			primaryIP = value.IP.String()
			break
		}
	}
	if primaryIP == "" {
		t.Fatal("fixture has no private container IP")
	}
	authority, revoke := context.WithCancel(context.Background())
	defer revoke()
	channels := []Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}}
	proxy, err := newBrowserLoopbackAppProxy(authority, channels)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.close()
	var allowed, forbidden atomic.Int64
	app := &http.Server{Addr: "127.0.0.1:3000", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stats":
			json.NewEncoder(w).Encode(map[string]any{"allowed": allowed.Load(), "forbidden": forbidden.Load(), "ip": primaryIP})
		case "/allowed":
			allowed.Add(1)
			fmt.Fprint(w, "App data loaded")
		case "/redirect":
			http.Redirect(w, r, "http://"+primaryIP+":3001/redirect-leak", http.StatusFound)
		default:
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprintf(w, `<!doctype html><html><head><title>Factory browser proof</title></head>
<body><h1>Declared App inspection</h1><button style="position:absolute;top:8px">Overlapping action</button>
<p id="data">Loading App data</p><p id="denied">Checking restricted subresources</p>
<input id="label" aria-label="Label"><button onclick="document.querySelector('#saved').textContent='Saved label: '+document.querySelector('#label').value">Save label</button><p id="saved">Not saved</p>
<script>console.error('Factory UI defect: action overlaps heading');
fetch('/allowed').then(r=>r.text()).then(text=>document.querySelector('#data').textContent=text);
Promise.all(['http://%s:3001/subresource-leak','http://169.254.169.254/latest/meta-data/',
'http://other.factory.invalid/','http://127.0.0.1:3001/','https://example.com/'].map(url=>fetch(url).then(()=>{throw new Error('forbidden request unexpectedly completed')}).catch(()=>true)))
.then(()=>document.querySelector('#denied').textContent='Restricted subresources denied');</script></body></html>`, primaryIP)
		}
	})}
	denied := &http.Server{Addr: ":3001", Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		forbidden.Add(1)
		fmt.Fprint(w, "FORBIDDEN FIXTURE")
	})}
	defer app.Close()
	defer denied.Close()
	go app.ListenAndServe()
	go denied.ListenAndServe()
	encoded, _ := json.Marshal(channels)
	if err := os.MkdirAll("/factory/browser/config", 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(browserAppsPath, encoded, 0444); err != nil {
		t.Fatal(err)
	}
	lease, _ := json.Marshal(browserAuthority{SessionID: "browser-proof", ExpiresAt: time.Now().Add(30 * time.Second)})
	if err := os.WriteFile(browserAuthorityPath, lease, 0444); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", browserSocketPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(browserSocketPath, 0660); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(browserSocketPath, 1000, 1000); err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 3 * time.Second, IdleTimeout: 15 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	if err := os.WriteFile("/factory/browser/ready", []byte(primaryIP), 0444); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(4 * time.Minute)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline.C:
			t.Fatal("live-browser fixture exceeded its deadline")
		case <-ticker.C:
			if _, err := os.Stat("/factory/browser/revoke"); err == nil {
				revoke()
			}
		}
	}
}

func TestBrowserMCPIsolatedLive(t *testing.T) {
	imageReference := os.Getenv("FACTORY_BROWSER_PROOF_IMAGE")
	if imageReference == "" {
		t.Skip("requires explicitly built browser proof image")
	}
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	docker := func(arguments ...string) string {
		t.Helper()
		operation, end := context.WithTimeout(ctx, 30*time.Second)
		defer end()
		output, err := exec.CommandContext(operation, "docker", arguments...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s: %v: %s", arguments[0], err, output)
		}
		return strings.TrimSpace(string(output))
	}
	image := docker("image", "inspect", "--format", "{{.Id}}", imageReference)
	if !regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(image) {
		t.Fatal("browser proof image did not resolve to an exact local digest")
	}
	arch := docker("info", "--format", "{{.Architecture}}")
	if arch == "aarch64" {
		arch = "arm64"
	} else if arch == "x86_64" {
		arch = "amd64"
	} else {
		t.Fatal("unsupported live-browser fixture architecture")
	}
	owned := "factory-browser-proof-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	root, err := filepath.Abs("../../../.factory/test-results/browser-tools/" + owned)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(root, "proxy-fixture")
	build := exec.CommandContext(ctx, "go", "test", "-c", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOOS=linux", "GOARCH="+arch, "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build disposable browser proxy fixture: %v: %s", err, output)
	}
	parent, browser, volume := owned+"-proxy", owned+"-browser", owned+"-socket"
	intent, _ := json.Marshal(map[string]string{"fixture": owned, "proxy": parent, "browser": browser, "volume": volume, "image": image})
	if err := os.WriteFile(filepath.Join(root, "intent.json"), intent, 0600); err != nil {
		t.Fatal(err)
	}
	// Only these exact test-owned names may be removed, and only with the retained
	// ownership label. Never touch an installation, Project, runtime or other test.
	t.Cleanup(func() {
		cleaned := make(map[string]bool)
		for _, name := range []string{browser, parent} {
			label, err := exec.Command("docker", "inspect", "--format", `{{index .Config.Labels "factory.dev/browser-proof"}}`, name).Output()
			if err != nil {
				continue
			}
			if strings.TrimSpace(string(label)) != owned {
				t.Errorf("refusing cleanup of non-owned container %s", name)
				continue
			}
			if output, err := exec.Command("docker", "rm", "-f", name).CombinedOutput(); err != nil {
				t.Errorf("owned browser cleanup failed: %v: %s", err, output)
			} else {
				cleaned[name] = true
			}
		}
		label, err := exec.Command("docker", "volume", "inspect", "--format", `{{index .Labels "factory.dev/browser-proof"}}`, volume).Output()
		if err == nil && strings.TrimSpace(string(label)) == owned {
			if output, err := exec.Command("docker", "volume", "rm", volume).CombinedOutput(); err != nil {
				t.Errorf("owned socket volume cleanup failed: %v: %s", err, output)
			} else {
				cleaned[volume] = true
			}
		}
		evidence, _ := json.Marshal(cleaned)
		os.WriteFile(filepath.Join(root, "cleanup.json"), evidence, 0600)
	})
	docker("volume", "create", "--label", "factory.dev/browser-proof="+owned, volume)
	docker("run", "-d", "--name", parent, "--label", "factory.dev/browser-proof="+owned,
		"--user", "0:0", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m",
		"--mount", "type=volume,src="+volume+",dst=/factory/browser",
		"--mount", "type=bind,src="+binary+",dst=/test,readonly",
		"--env", "FACTORY_BROWSER_PROXY_FIXTURE=1", "--entrypoint", "/test", image,
		"-test.run=^TestBrowserMCPProxyFixture$", "-test.timeout=250s")
	ready := false
	for attempt := 0; attempt < 40; attempt++ {
		if exec.CommandContext(ctx, "docker", "exec", parent, "test", "-f", "/factory/browser/ready").Run() == nil {
			ready = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		t.Fatalf("proxy fixture unavailable: %s", docker("logs", parent))
	}
	command := exec.CommandContext(ctx, "docker", "run", "--interactive", "--name", browser,
		"--label", "factory.dev/browser-proof="+owned, "--network", "none", "--read-only",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
		"--memory", "768m", "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777",
		"--mount", "type=volume,src="+volume+",dst=/factory/browser,readonly", image)
	input, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		input.Close()
		if !waited {
			command.Process.Kill()
			command.Wait()
		}
		if t.Failed() {
			t.Logf("isolated MCP startup diagnostics: %s", stderr.String())
		}
	}()
	responses := make(chan browserMCPReply, 16)
	go func() {
		defer close(responses)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 65536), 3<<20)
		for scanner.Scan() {
			var response browserMCPReply
			if json.Unmarshal(scanner.Bytes(), &response) == nil && response.ID != 0 {
				responses <- response
			}
		}
	}()
	nextID := 0
	call := func(method string, params any) json.RawMessage {
		t.Helper()
		nextID++
		if err := json.NewEncoder(input).Encode(map[string]any{"jsonrpc": "2.0", "id": nextID, "method": method, "params": params}); err != nil {
			t.Fatal(err)
		}
		select {
		case response, ok := <-responses:
			if !ok || response.ID != nextID || len(response.Error) != 0 {
				t.Fatalf("MCP %s failed: %+v", method, response)
			}
			return response.Result
		case <-time.After(30 * time.Second):
			t.Fatalf("MCP %s exceeded 30 seconds", method)
			return nil
		}
	}
	tool := func(name string, arguments any) browserMCPContent {
		t.Helper()
		var content browserMCPContent
		if err := json.Unmarshal(call("tools/call", map[string]any{"name": name, "arguments": arguments}), &content); err != nil {
			t.Fatal(err)
		}
		return content
	}
	channels := []Channel{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}}
	factoryTool := func(name string, arguments any, pageID int) browserMCPContent {
		t.Helper()
		encoded, err := json.Marshal(arguments)
		if err != nil {
			t.Fatal(err)
		}
		dispatch, err := resolveBrowserTool(channels, pageID, browserToolCall{Name: name, Arguments: encoded})
		if err != nil {
			t.Fatal(err)
		}
		raw := call("tools/call", map[string]any{"name": dispatch.Name, "arguments": dispatch.Arguments})
		bounded, err := boundBrowserResult(name, raw)
		if err != nil {
			t.Fatal(err)
		}
		return bounded
	}
	text := func(content browserMCPContent) string {
		var result strings.Builder
		for _, item := range content.Content {
			result.WriteString(item.Text)
		}
		return result.String()
	}
	initial := call("initialize", map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "factory-browser-proof", "version": "1"}})
	if !bytes.Contains(initial, []byte("1.10.1")) {
		t.Fatalf("unexpected upstream MCP identity: %s", initial)
	}
	json.NewEncoder(input).Encode(map[string]string{"jsonrpc": "2.0", "method": "notifications/initialized"})
	tools := call("tools/list", map[string]any{})
	for _, forbiddenTool := range []string{"evaluate_script", "performance_start_trace", "install_extension", "list_network_requests"} {
		if bytes.Contains(tools, []byte(`"name":"`+forbiddenTool+`"`)) {
			t.Errorf("disabled tool exposed: %s", forbiddenTool)
		}
	}
	page := factoryTool("browser_open", map[string]any{"app": "web", "path": "/inspect"}, 0)
	if page.IsError {
		t.Fatalf("declared App navigation failed: %s", text(page))
	}
	pageID := regexp.MustCompile(`(?m)^(\d+): [^\n]*\(http://web\.factory\.invalid/inspect\)`).FindStringSubmatch(text(page))
	if len(pageID) != 2 {
		t.Fatalf("missing declared App page identity: %s", text(page))
	}
	id, _ := strconv.Atoi(pageID[1])
	snapshot := factoryTool("browser_snapshot", map[string]any{}, id)
	if snapshot.IsError || !strings.Contains(text(snapshot), "App data loaded") || !strings.Contains(text(snapshot), "Restricted subresources denied") {
		t.Fatalf("actual App DOM/subresources unavailable: %s", text(snapshot))
	}
	inputUID := regexp.MustCompile(`uid=([0-9]+_[0-9]+) textbox "Label"`).FindStringSubmatch(text(snapshot))
	buttonUID := regexp.MustCompile(`uid=([0-9]+_[0-9]+) button "Save label"`).FindStringSubmatch(text(snapshot))
	if len(inputUID) != 2 || len(buttonUID) != 2 {
		t.Fatalf("fixture UI controls absent from actual snapshot: %s", text(snapshot))
	}
	if result := factoryTool("browser_fill", map[string]any{"uid": inputUID[1], "value": "Updated"}, id); result.IsError {
		t.Fatalf("bounded App fill failed: %s", text(result))
	}
	if result := factoryTool("browser_click", map[string]any{"uid": buttonUID[1]}, id); result.IsError {
		t.Fatalf("bounded App click failed: %s", text(result))
	}
	if result := factoryTool("browser_wait", map[string]any{"text": "Saved label: Updated"}, id); result.IsError {
		t.Fatalf("bounded App wait failed: %s", text(result))
	}
	console := factoryTool("browser_console", map[string]any{}, id)
	if console.IsError || !strings.Contains(text(console), "Factory UI defect: action overlaps heading") {
		t.Fatalf("actual App console unavailable: %s", text(console))
	}
	screenshot := factoryTool("browser_screenshot", map[string]any{}, id)
	imageFound := false
	for _, item := range screenshot.Content {
		if item.Type != "image" || item.MimeType != "image/jpeg" {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(item.Data)
		if err != nil || len(data) > 2_000_000 {
			t.Fatal("unbounded or invalid browser screenshot")
		}
		config, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width > 1280 || config.Height > 720 {
			t.Fatalf("invalid screenshot dimensions: %+v %v", config, err)
		}
		if err := os.WriteFile(filepath.Join(root, "inspection.jpg"), data, 0600); err != nil {
			t.Fatal(err)
		}
		imageFound = true
	}
	if !imageFound || screenshot.IsError {
		t.Fatalf("actual bounded screenshot unavailable: %s", text(screenshot))
	}
	for _, target := range []string{"http://other.factory.invalid/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:3001/", "https://example.com/", "file:///etc/passwd"} {
		denial := tool("new_page", map[string]any{"url": target, "timeout": 2000})
		if !denial.IsError {
			t.Errorf("forbidden navigation completed: %s: %s", target, text(denial))
		}
	}
	redirect := tool("navigate_page", map[string]any{"pageId": id, "url": "http://web.factory.invalid/redirect", "timeout": 2000})
	redirectDOM := tool("take_snapshot", map[string]any{"pageId": id})
	if strings.Contains(text(redirectDOM), "FORBIDDEN FIXTURE") || !strings.Contains(text(redirectDOM), "browser target is not a declared App") {
		t.Fatalf("forbidden redirect was not denied at App boundary: %s: %s", text(redirect), text(redirectDOM))
	}
	var stats struct {
		Allowed   int64  `json:"allowed"`
		Forbidden int64  `json:"forbidden"`
		IP        string `json:"ip"`
	}
	readStats := func() {
		value := docker("exec", parent, "/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:3000/stats').then(r=>r.text()).then(t=>process.stdout.write(t))")
		if err := json.Unmarshal([]byte(value), &stats); err != nil {
			t.Fatal(err)
		}
	}
	readStats()
	if stats.Allowed != 1 || stats.Forbidden != 0 {
		t.Fatalf("unexpected actual network traffic: %+v", stats)
	}
	// This bypasses Chrome, MCP and every URL allowlist. Network isolation itself
	// must still prevent a TCP connection to the fixture's undeclared port.
	docker("exec", browser, "/usr/local/bin/node", "-e",
		"const net=require('net');const s=net.connect(3001,'"+stats.IP+"');s.setTimeout(2000);s.on('connect',()=>process.exit(1));s.on('timeout',()=>process.exit(2));s.on('error',e=>{if(e.code!=='ENETUNREACH')process.exit(3);process.stdout.write('network bypass denied')})")
	docker("exec", parent, "/usr/local/bin/node", "-e", "require('fs').writeFileSync('/factory/browser/revoke','')")
	time.Sleep(100 * time.Millisecond)
	tool("navigate_page", map[string]any{"pageId": id, "url": "http://web.factory.invalid/allowed", "timeout": 2000})
	ended := tool("take_snapshot", map[string]any{"pageId": id})
	if !strings.Contains(text(ended), "browser execution authority ended") {
		t.Fatalf("revoked browser still reaches App: %s", text(ended))
	}
	readStats()
	if stats.Allowed != 1 || stats.Forbidden != 0 {
		t.Fatalf("requests escaped revoked browser authority: %+v", stats)
	}
	boundary := docker("inspect", "--format", "{{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.Privileged}}", browser)
	if boundary != "none true 1000:1000 false" {
		t.Fatalf("actual browser isolation differs from the approved boundary: %s", boundary)
	}
	chromeVersion := docker("exec", browser, "/opt/factory/chromium", "--version")
	input.Close()
	exited := make(chan error, 1)
	go func() { exited <- command.Wait() }()
	select {
	case err := <-exited:
		waited = true
		if err != nil {
			t.Fatalf("browser worker did not shut down cleanly on MCP EOF: %v", err)
		}
	case <-time.After(10 * time.Second):
		command.Process.Kill()
		<-exited
		waited = true
		t.Fatal("browser worker exceeded its EOF cleanup deadline")
	}
	if docker("inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", browser) != "exited 0" {
		t.Fatal("browser container survived the end of its MCP client")
	}
	evidence, _ := json.Marshal(map[string]any{"mcp": "1.10.1", "image": image, "chrome": chromeVersion, "network": "none", "appRequests": stats.Allowed, "forbiddenRequests": stats.Forbidden, "eofCleanup": true, "durationMs": time.Since(started).Milliseconds()})
	if err := os.WriteFile(filepath.Join(root, "inspection.json"), evidence, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("real isolated MCP inspection, denials and revocation passed; evidence %s", root)
}
