package browser

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
