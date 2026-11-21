package connector

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/jpeg"
	"io"
	"os"
	"strings"
	"testing"
)

func browserScreenshotReply(t *testing.T, data []byte) []byte {
	t.Helper()
	reply, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 9, "trace": "preserved",
		"result": map[string]any{
			"structuredContent": map[string]any{"pageId": 3},
			"content": []map[string]string{
				{"type": "text", "text": "Screenshot of the declared App"},
				{"type": "image", "mimeType": "image/jpeg", "data": base64.StdEncoding.EncodeToString(data)},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestBrowserWorkerNormalizesFastJPEGWithoutChangingItsEnvelope(t *testing.T) {
	// Captured from the pinned worker in an owned ARM gVisor/private-Docker
	// fixture. It contains only this test's flat grey/red/blue pattern.
	data, err := os.ReadFile("testdata/browser-fast-jpeg.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if jpegFirstScanComponents(data) != 1 {
		t.Fatal("fixture must reproduce the model reader's unsupported scan layout")
	}
	line := browserScreenshotReply(t, data)
	normalized, err := normalizeBrowserScreenshot(line)
	if err != nil {
		t.Fatal(err)
	}
	var before, after map[string]any
	_ = json.Unmarshal(line, &before)
	_ = json.Unmarshal(normalized, &after)
	content := after["result"].(map[string]any)["content"].([]any)
	item := content[1].(map[string]any)
	encoded, err := base64.StdEncoding.DecodeString(item["data"].(string))
	if err != nil || jpegFirstScanComponents(encoded) != 3 {
		t.Fatal("screenshot must use an interleaved baseline color scan")
	}
	decoded, err := jpeg.Decode(bytes.NewReader(encoded))
	if err != nil || decoded.Bounds() != image.Rect(0, 0, 1280, 720) {
		t.Fatal("screenshot dimensions or JPEG changed", err)
	}
	for y, expected := range map[int][3]int{90: {240, 240, 240}, 270: {220, 30, 30}, 450: {30, 30, 220}, 630: {240, 240, 240}} {
		r, g, b, _ := decoded.At(640, y).RGBA()
		if abs(int(r>>8)-expected[0]) > 5 || abs(int(g>>8)-expected[1]) > 5 || abs(int(b>>8)-expected[2]) > 5 {
			t.Fatalf("screenshot pixels changed at row %d", y)
		}
	}
	// Apart from JPEG bytes, preserve IDs, text, media type, provenance and
	// unknown upstream fields instead of reconstructing the MCP envelope.
	item["data"] = before["result"].(map[string]any)["content"].([]any)[1].(map[string]any)["data"]
	beforeBytes, _ := json.Marshal(before)
	afterBytes, _ := json.Marshal(after)
	if !bytes.Equal(beforeBytes, afterBytes) {
		t.Fatal("normalization changed non-image MCP content")
	}
	var output bytes.Buffer
	writer := &browserScreenshotOutput{writer: &output}
	stream := append(append([]byte(`{"jsonrpc":"2.0","method":"notification"}`+"\n"), line...), '\n')
	for _, chunk := range [][]byte{stream[:15], stream[15:71], stream[71:]} {
		if count, err := writer.Write(chunk); err != nil || count != len(chunk) {
			t.Fatal("fragmented MCP stream failed", count, err)
		}
	}
	expected := append(append([]byte(`{"jsonrpc":"2.0","method":"notification"}`+"\n"), normalized...), '\n')
	if !bytes.Equal(output.Bytes(), expected) || len(writer.pending) != 0 {
		t.Fatal("fragmented MCP output changed its envelope or line boundaries")
	}
}

func TestBrowserWorkerScreenshotOutputRejectsInvalidImagesAndEndsAuthority(t *testing.T) {
	var oversize bytes.Buffer
	_ = jpeg.Encode(&oversize, image.NewRGBA(image.Rect(0, 0, 1281, 1)), nil)
	for name, line := range map[string][]byte{
		"invalid-jpeg": browserScreenshotReply(t, []byte("not a JPEG")),
		"oversize":     browserScreenshotReply(t, oversize.Bytes()),
		"flood":        bytes.Repeat([]byte("x"), (3<<20)+1),
	} {
		t.Run(name, func(t *testing.T) {
			var output bytes.Buffer
			canceled := false
			writer := &browserScreenshotOutput{writer: &output, cancel: func() { canceled = true }}
			if _, err := writer.Write(append(line, '\n')); err == nil || !canceled || output.Len() != 0 {
				t.Fatal("invalid screenshot output retained authority or published bytes")
			}
		})
	}
}

func TestBrowserWorkerScreenshotOutputLeavesOtherRepliesUntouched(t *testing.T) {
	for _, line := range []string{
		`{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"version":"1.13.0"}}}`,
		`{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"App unavailable"}]}}`,
		`{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","mimeType":"image/png","data":"opaque"}]}}`,
	} {
		out, err := normalizeBrowserScreenshot([]byte(line))
		if err != nil || string(out) != line {
			t.Fatal("non-JPEG reply changed", err)
		}
	}
}

type browserFailedOutput struct{}

func (browserFailedOutput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestBrowserWorkerScreenshotOutputFailureEndsAuthority(t *testing.T) {
	canceled := false
	writer := &browserScreenshotOutput{writer: browserFailedOutput{}, cancel: func() { canceled = true }}
	if _, err := writer.Write([]byte("{}\n")); err != io.ErrClosedPipe || !canceled {
		t.Fatal("failed output must end this worker's authority")
	}
}

func TestBrowserWorkerFixedConfiguration(t *testing.T) {
	arguments, err := browserWorkerArguments([]Channel{
		{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if arguments[0] != "/opt/factory/browser-mcp/entrypoint.js" {
		t.Fatal("worker must use the package-bin launcher checked while building its image")
	}
	flags := strings.Join(arguments, "\n")
	for _, expected := range []string{
		"--isolated", "--headless", "--no-javascript-evaluation", "--no-usage-statistics",
		"--no-category-network", "--no-category-performance", "--no-category-extensions",
		"--no-category-experimental-webmcp", "--no-category-experimental-third-party",
		"--proxy-server=http://127.0.0.1:3128", "--chrome-arg=--proxy-bypass-list=<-loopback>",
		"--screenshot-max-width=1280", "--screenshot-max-height=720",
		"--allowed-url-pattern=http://web.factory.invalid/*",
		"--allowed-url-pattern=http://127.0.0.1:3000/*",
	} {
		if !strings.Contains(flags, expected) {
			t.Errorf("missing fixed flag %s", expected)
		}
	}
}

func TestBrowserWorkerRejectsNonAppAndInvalidAssignments(t *testing.T) {
	for _, channels := range [][]Channel{
		nil,
		{{Name: "agent", Kind: "agent", Target: "http://127.0.0.1:4096"}},
		{{Name: "web", Kind: "app", Target: "http://169.254.169.254:80"}},
		{{Name: "web*", Kind: "app", Target: "http://127.0.0.1:3000"}},
		{{Name: "web", Kind: "app", Target: "http://127.0.0.1:3000"}, {Name: "web", Kind: "app", Target: "http://127.0.0.1:3001"}},
	} {
		if _, err := browserWorkerArguments(channels); err == nil {
			t.Errorf("unexpected browser authority for %+v", channels)
		}
	}
}
