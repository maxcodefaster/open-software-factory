package connector

import (
	"context"
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
