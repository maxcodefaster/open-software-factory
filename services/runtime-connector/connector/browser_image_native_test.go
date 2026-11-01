package connector

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// The explicit native fixture owns a tiny TLS Registry and one labeled image.
// Ordinary Connector checks do not download images or start Docker resources.
func TestBrowserImageRecoveryWithNativeDocker(t *testing.T) {
	reference := os.Getenv("FACTORY_BROWSER_IMAGE_RECOVERY_REFERENCE")
	if reference == "" {
		t.Skip("requires the explicit owned native Registry fixture")
	}
	if !strings.HasPrefix(reference, "registry.localhost:") ||
		!strings.Contains(reference, "/factory-owned-browser-image-") ||
		!browserImagePattern.MatchString(reference) {
		t.Fatal("native image recovery requires its owned local Registry reference")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := ensureBrowserImage(ctx, reference); err != nil {
		t.Fatal("native Docker did not recover its exact image after Registry availability returned", err)
	}
}

func TestProjectImageRecoveryWithNativeDocker(t *testing.T) {
	reference := os.Getenv("FACTORY_PROJECT_IMAGE_RECOVERY_REFERENCE")
	if reference == "" {
		t.Skip("requires the explicit owned native Registry fixture")
	}
	if !strings.HasPrefix(reference, "registry.localhost:") ||
		!strings.Contains(reference, "/factory-owned-project-image-") ||
		!browserImagePattern.MatchString(reference) {
		t.Fatal("native Project image recovery requires its owned local Registry reference")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := prepareProjectImages(ctx, []string{reference}); err != nil {
		t.Fatal("native Docker did not recover its exact Project image after Registry availability returned", err)
	}
}

// Run only in an owned fixture with a private Docker daemon whose data root is
// a 32-MiB tmpfs. The valid 64-MiB layer must fail actual native extraction,
// rather than substituting a fake Docker executable or failing Registry access.
func TestBrowserImageStorageFailureWithNativeDocker(t *testing.T) {
	owner := os.Getenv("FACTORY_BROWSER_STORAGE_NATIVE_OWNER")
	if owner == "" {
		t.Skip("requires the explicit owned private-Docker storage fixture")
	}
	marker, err := os.ReadFile("/run/factory-browser-storage-owner")
	if err != nil || strings.TrimSpace(string(marker)) != owner || len(owner) != 32 {
		t.Fatal("native storage proof has no exact private-daemon owner")
	}
	var layer bytes.Buffer
	compressed := gzip.NewWriter(&layer)
	diff := sha256.New()
	archive := tar.NewWriter(io.MultiWriter(compressed, diff))
	const size = 64 << 20
	if err := archive.WriteHeader(&tar.Header{Name: "owned-storage-proof", Mode: 0600, Size: size}); err != nil {
		t.Fatal(err)
	}
	zeroes := make([]byte, 64<<10)
	for written := 0; written < size; written += len(zeroes) {
		if _, err := archive.Write(zeroes); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	digest := func(data []byte) string { return fmt.Sprintf("sha256:%x", sha256.Sum256(data)) }
	architecture := os.Getenv("FACTORY_BROWSER_STORAGE_NATIVE_ARCH")
	if architecture != "arm64" && architecture != "amd64" {
		t.Fatal("native storage fixture architecture is unknown")
	}
	config, err := json.Marshal(map[string]any{
		"architecture": architecture, "os": "linux",
		"config": map[string]any{"Labels": map[string]string{"factory.owned-browser-storage": owner}},
		"rootfs": map[string]any{"type": "layers", "diff_ids": []string{fmt.Sprintf("sha256:%x", diff.Sum(nil))}},
	})
	if err != nil {
		t.Fatal(err)
	}
	configDigest, layerDigest := digest(config), digest(layer.Bytes())
	manifest, err := json.Marshal(map[string]any{
		"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
		"config": map[string]any{"mediaType": "application/vnd.oci.image.config.v1+json",
			"digest": configDigest, "size": len(config)},
		"layers": []any{map[string]any{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
			"digest": layerDigest, "size": layer.Len()}},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := digest(manifest)
	repository := "factory-owned-browser-storage-" + owner + "/browser-tools"
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("docker-distribution-api-version", "registry/2.0")
		var body []byte
		switch request.URL.Path {
		case "/v2/":
			body = []byte("{}")
		case "/v2/" + repository + "/manifests/" + manifestDigest:
			body = manifest
			writer.Header().Set("content-type", "application/vnd.oci.image.manifest.v1+json")
			writer.Header().Set("docker-content-digest", manifestDigest)
		case "/v2/" + repository + "/blobs/" + configDigest:
			body = config
		case "/v2/" + repository + "/blobs/" + layerDigest:
			body = layer.Bytes()
		default:
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("content-length", fmt.Sprint(len(body)))
		if request.Method != http.MethodHead {
			_, _ = writer.Write(body)
		}
	}))
	defer server.Close()
	reference := strings.TrimPrefix(server.URL, "http://") + "/" + repository + "@" + manifestDigest
	preparation := prepareBrowserImage(context.Background(), func(ctx context.Context) error {
		return ensureBrowserImage(ctx, reference)
	})
	defer preparation.stop()
	if err := preparation.ready(owner); err == nil || !strings.Contains(err.Error(), "preparing") {
		t.Fatal("native image preparation did not retain its pre-execution boundary", err)
	}
	<-preparation.done
	if err := preparation.ready(owner); !errors.Is(err, errBrowserImageStorageExhausted) {
		t.Fatal("actual native extraction ENOSPC lost its safe storage diagnostic", err)
	}
	if _, err := browserDocker(context.Background(), "image", "inspect", reference); err == nil {
		t.Fatal("failed native extraction published a usable image")
	}
}
