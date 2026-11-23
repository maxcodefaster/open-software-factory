package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// Private dependency injection for owned component fixtures. Neither Project
// configuration nor an Assignment can select another installation tool root.
type openCodeArtifactsRootKey struct{}

func openCodeArtifactsRoot(ctx context.Context) string {
	if root, ok := ctx.Value(openCodeArtifactsRootKey{}).(string); ok {
		return root
	}
	return "/opt/factory/opencode"
}

const preparedOpenCodeFeature = ".factory-opencode-tools"

// Only a new producer stages this Feature. Consumer fingerprint observations
// read the small packaged manifest, not another copy of its payload.
func stagePrebuildOpenCode(ctx context.Context, operation prebuildOperation, snapshot string) error {
	root := openCodeArtifactsRoot(ctx)
	_, digest, err := ReadOpenCodeArtifactsManifest(root)
	if err != nil || digest != operation.Input.OpenCodeArtifactsSHA256 {
		return errors.New("Prepared OpenCode payload differs from its frozen build input")
	}
	configPath := filepath.Join(snapshot, operation.Input.Configuration)
	feature := filepath.Join(filepath.Dir(configPath), preparedOpenCodeFeature)
	if !pathWithin(filepath.Join(snapshot, ".devcontainer"), filepath.Dir(feature)) {
		return errors.New("Prepared OpenCode Feature must stay in the private Dev Container snapshot")
	}
	if err := os.Mkdir(feature, 0755); err != nil {
		return errors.New("Prepared OpenCode Feature already has an owner")
	}
	// The CLI normalizes loose Feature files to executable permissions. Preserve
	// the exact shipped modes/symlinks inside one allowlisted archive instead.
	// No model configuration, Skills, Source or session state enters it.
	if err := ownedCommand(ctx, "tar", "-C", root, "-cf", filepath.Join(feature, "payload.tar"),
		"server", "glibc/bun", "musl/bun").Run(); err != nil {
		return errors.New("Prepared OpenCode payload staging failed")
	}
	content, err := os.ReadFile(configPath)
	var document map[string]json.RawMessage
	if err != nil || json.Unmarshal(content, &document) != nil {
		return errors.New("Prepared OpenCode configuration is unavailable")
	}
	features := map[string]json.RawMessage{}
	if raw := document["features"]; raw != nil && json.Unmarshal(raw, &features) != nil {
		return errors.New("Prepared OpenCode Feature declarations are invalid")
	}
	var after []string
	for id := range features {
		after = append(after, id)
	}
	sort.Strings(after)
	declaration, _ := json.Marshal(map[string]any{
		"id": "factory-opencode-tools", "version": "1.0.0",
		"name": "Factory packaged OpenCode", "installsAfter": after,
	})
	if err := os.WriteFile(filepath.Join(feature, "devcontainer-feature.json"), declaration, 0644); err != nil {
		return err
	}
	const installer = `#!/bin/sh
set -eu
cd "$(dirname "$0")"
payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
tar -xf payload.tar -C "$payload"
libc=glibc
if ldd --version 2>&1 | grep -qi musl; then libc=musl; fi
test ! -L /opt
test ! -L /opt/factory
test ! -L /opt/factory/opencode
mkdir -p /opt/factory/opencode
rm -rf /opt/factory/opencode/server /opt/factory/opencode/bun
mkdir -p /opt/factory/opencode/server
cp -a "$payload/server/." /opt/factory/opencode/server/
cp "$payload/$libc/bun" /opt/factory/opencode/bun
chmod -R a+rX,go-w /opt/factory/opencode/server
chmod 0555 /opt/factory/opencode/bun
`
	if err := os.WriteFile(filepath.Join(feature, "install.sh"), []byte(installer), 0755); err != nil {
		return err
	}
	features["./"+preparedOpenCodeFeature] = json.RawMessage(`{}`)
	document["features"], _ = json.Marshal(features)
	content, _ = json.Marshal(document)
	if err := os.WriteFile(configPath, content, 0600); err != nil {
		return err
	}
	if operation.Input.buildContext != "" && pathWithin(operation.Input.buildContext, feature) {
		relative, err := filepath.Rel(operation.Input.buildContext, feature)
		if err != nil {
			return err
		}
		// The generated Feature is not authored application source. Exclude only
		// it from COPY/build contexts; the CLI stages its Feature independently.
		exclusion := "\n/" + filepath.ToSlash(relative) + "/\n"
		ignores := []string{filepath.Join(operation.Input.buildContext, ".dockerignore")}
		if operation.Input.Dockerfile != "" {
			specific := filepath.Join(snapshot, operation.Input.Dockerfile) + ".dockerignore"
			if _, err := os.Stat(specific); err == nil {
				ignores = append(ignores, specific)
			} else if !os.IsNotExist(err) {
				return err
			}
		}
		for _, path := range ignores {
			if _, err := os.Lstat(path); err == nil {
				resolved, err := filepath.EvalSymlinks(path)
				if err != nil || !pathWithin(snapshot, resolved) {
					return errors.New("Prepared OpenCode ignore file leaves its snapshot")
				}
			} else if !os.IsNotExist(err) {
				return err
			}
			file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			_, writeErr := file.WriteString(exclusion)
			if err := errors.Join(writeErr, file.Close()); err != nil {
				return err
			}
		}
	}
	// Keep metadata private; a writable image label/manifest never replaces
	// actual content verification in the consuming Dev Container.
	return nil
}
