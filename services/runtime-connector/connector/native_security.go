package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Supply the required primary restrictions through the same private effective
// configuration used for prepared images. Source, its paths/user/hooks and the
// CLI stay unchanged; the normal pre-up and inspected boundaries still apply.
func prepareNativeSecurity(ctx context.Context, assignment Assignment) (string, func(), error) {
	noop := func() {}
	if assignment.nativeActorUID == "" {
		return "", noop, nil
	}
	if assignment.nativeActorUID != os.Getenv("FACTORY_SUBSTRATE_ACTOR_UID") {
		return "", noop, errors.New("native security Actor identity changed")
	}
	configPath := filepath.Join(assignment.WorkspaceFolder, assignment.DevcontainerPath)
	var source []byte
	var err error
	if assignment.EffectiveConfiguration != "" {
		// Only Factory sets this unexported-on-the-wire preparation field.
		// Retain its selected image, Compose overrides and hook decisions.
		source, err = readNativePrebuildRecipeFile(assignment.EffectiveConfiguration)
	} else {
		command := ownedCommand(ctx, "devcontainer", "read-configuration",
			"--workspace-folder", assignment.WorkspaceFolder, "--config", configPath, "--log-format", "json")
		command.Env = devcontainerEnvironment(assignment)
		var output []byte
		output, err = command.Output()
		if len(output) > 1<<20 {
			return "", noop, errors.New("native security configuration is too large")
		}
		for _, line := range strings.Split(string(output), "\n") {
			var result struct {
				Configuration json.RawMessage `json:"configuration"`
			}
			if json.Unmarshal([]byte(line), &result) == nil && len(result.Configuration) != 0 {
				source = result.Configuration
			}
		}
	}
	var config map[string]json.RawMessage
	if err != nil || json.Unmarshal(source, &config) != nil || config == nil {
		return "", noop, errors.New("native security configuration is unavailable")
	}
	directory, err := os.MkdirTemp("", "factory-native-security-")
	if err != nil {
		return "", noop, err
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	if config["dockerComposeFile"] != nil {
		err = configureNativeComposeSecurity(ctx, assignment, configPath, directory, config)
	} else {
		var args []string
		if raw := config["runArgs"]; raw != nil && json.Unmarshal(raw, &args) != nil {
			err = errors.New("native primary run arguments are invalid")
		} else {
			var dropped []string
			for index := 0; index < len(args); index++ {
				name, value, assigned := strings.Cut(args[index], "=")
				if name != "--cap-drop" {
					continue
				}
				if !assigned && index+1 < len(args) {
					index++
					value = args[index]
				}
				dropped = append(dropped, strings.Split(value, ",")...)
			}
			for _, capability := range missingNativePrimaryDrops(dropped) {
				args = append(args, "--cap-drop="+capability)
			}
			config["runArgs"], err = json.Marshal(args)
		}
	}
	path := filepath.Join(directory, "devcontainer.json")
	if err == nil {
		var encoded []byte
		encoded, err = json.Marshal(config)
		if err == nil {
			err = os.WriteFile(path, encoded, 0600)
		}
	}
	if err != nil {
		cleanup()
		return "", noop, err
	}
	return path, cleanup, nil
}

func missingNativePrimaryDrops(capabilities []string) []string {
	dropped := map[string]bool{}
	for _, capability := range capabilities {
		dropped[strings.TrimPrefix(strings.ToUpper(capability), "CAP_")] = true
	}
	var missing []string
	for _, required := range []string{"NET_RAW", "SYS_PTRACE"} {
		if !dropped["ALL"] && !dropped[required] {
			missing = append(missing, required)
		}
	}
	return missing
}

func configureNativeComposeSecurity(ctx context.Context, assignment Assignment, configPath, directory string, config map[string]json.RawMessage) error {
	var service string
	if json.Unmarshal(config["service"], &service) != nil || !composeServiceName.MatchString(service) {
		return errors.New("native security primary service is unavailable")
	}
	var files []string
	if assignment.EffectiveConfiguration == "" {
		var declaration any
		if json.Unmarshal(config["dockerComposeFile"], &declaration) != nil {
			return errors.New("native security Compose files are invalid")
		}
		var err error
		files, err = committedComposeFiles(assignment.WorkspaceFolder, configPath, declaration)
		if err != nil {
			return err
		}
	} else {
		// Existing Factory consumers emit absolute original files followed by
		// their private image/build overlay. Preserve that order and base.
		if json.Unmarshal(config["dockerComposeFile"], &files) != nil || len(files) == 0 {
			return errors.New("native security effective Compose files are unavailable")
		}
		for _, file := range files {
			if !filepath.IsAbs(file) || filepath.Clean(file) != file {
				return errors.New("native security effective Compose path is invalid")
			}
		}
	}
	args := []string{"compose"}
	for _, file := range files {
		args = append(args, "--file", file)
	}
	output, err := runtimeDockerCommand(ctx, append(args, "config", "--format", "json")...).Output()
	var model struct {
		Services map[string]struct {
			CapDrop []string `json:"cap_drop"`
		} `json:"services"`
	}
	if err != nil || len(output) > 2<<20 || json.Unmarshal(output, &model) != nil {
		return errors.New("native security Compose configuration is unavailable")
	}
	primary, exists := model.Services[service]
	if !exists {
		return errors.New("native security primary service is undeclared")
	}
	if missing := missingNativePrimaryDrops(primary.CapDrop); len(missing) != 0 {
		// Compose merges cap_drop sequences, preserving any authored stronger
		// restrictions. Never replace the service or touch dependency services.
		overlay := filepath.Join(directory, "compose-security.json")
		encoded, _ := json.Marshal(map[string]any{"services": map[string]any{
			service: map[string]any{"cap_drop": missing},
		}})
		if err := os.WriteFile(overlay, encoded, 0600); err != nil {
			return err
		}
		files = append(files, overlay)
	}
	config["dockerComposeFile"], err = json.Marshal(files)
	return err
}
