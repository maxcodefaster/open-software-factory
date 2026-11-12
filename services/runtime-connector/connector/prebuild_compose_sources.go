package connector

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Compose owns interpolation and merging. This admission only prevents its
// configuration reader from consulting files outside the committed snapshot or
// implicitly selecting build inputs from the producer's environment.
func admitComposePrebuildSources(snapshot string, files []string) error {
	visited := map[string]bool{}
	var visit func(string) error
	visit = func(path string) error {
		if visited[path] {
			return nil
		}
		visited[path] = true
		content, err := os.ReadFile(path)
		if err != nil || len(content) > 1<<20 {
			return errors.New("prebuild Compose source is unavailable or too large")
		}
		var document map[string]any
		decoder := yaml.NewDecoder(strings.NewReader(string(content)))
		var trailing any
		if decoder.Decode(&document) != nil || decoder.Decode(&trailing) != io.EOF {
			return errors.New("prebuild Compose source is invalid")
		}
		if err := admitComposePrebuildDocumentStrings(document); err != nil {
			return err
		}
		base := filepath.Dir(path)
		check := func(value any) error {
			for _, entry := range composePrebuildList(value) {
				if object, ok := entry.(map[string]any); ok {
					entry = object["path"]
				}
				name, ok := entry.(string)
				if !ok {
					return errors.New("prebuild Compose file reference is invalid")
				}
				if _, err := committedComposePath(snapshot, base, name); err != nil {
					return err
				}
			}
			return nil
		}
		for _, kind := range []string{"secrets", "configs"} {
			definitions, _ := document[kind].(map[string]any)
			for _, definition := range definitions {
				if object, ok := definition.(map[string]any); ok {
					if object["environment"] != nil {
						return errors.New("prebuild Compose cannot read the producer environment")
					}
					if object["file"] != nil {
						if err := check(object["file"]); err != nil {
							return err
						}
					}
				}
			}
		}
		for _, entry := range composePrebuildList(document["include"]) {
			if object, ok := entry.(map[string]any); ok {
				if object["env_file"] != nil {
					if err := check(object["env_file"]); err != nil {
						return err
					}
				}
				if name, ok := object["project_directory"].(string); ok {
					var err error
					_, err = committedComposePath(snapshot, base, name)
					if err != nil {
						return err
					}
				}
				entry = object["path"]
			}
			for _, name := range composePrebuildList(entry) {
				value, ok := name.(string)
				if !ok {
					return errors.New("prebuild Compose include is invalid")
				}
				child, err := committedComposePath(snapshot, base, value)
				if err != nil {
					return err
				}
				if err := visit(child); err != nil {
					return err
				}
			}
		}
		services, _ := document["services"].(map[string]any)
		for _, service := range services {
			object, _ := service.(map[string]any)
			if object["env_file"] != nil {
				if err := check(object["env_file"]); err != nil {
					return err
				}
			}
			if extends, ok := object["extends"].(map[string]any); ok && extends["file"] != nil {
				name, ok := extends["file"].(string)
				if !ok {
					return errors.New("prebuild Compose extends file is invalid")
				}
				child, err := committedComposePath(snapshot, base, name)
				if err != nil {
					return err
				}
				if err := visit(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, path := range files {
		if err := visit(path); err != nil {
			return err
		}
	}
	return nil
}

func composePrebuildList(value any) []any {
	if value == nil {
		return nil
	}
	if list, ok := value.([]any); ok {
		return list
	}
	return []any{value}
}

// Service environment is a Runtime input, not an image-build input. Compose
// reads it without interpolation below, and the isolated producer removes that
// field before invoking build. Everywhere else (including image, build, file
// selection and extension definitions) still rejects producer interpolation.
func admitComposePrebuildDocumentStrings(document map[string]any) error {
	for key, value := range document {
		if key != "services" {
			if err := admitComposePrebuildStrings(map[string]any{key: value}); err != nil {
				return err
			}
			continue
		}
		services, ok := value.(map[string]any)
		if !ok {
			return errors.New("prebuild Compose services are invalid")
		}
		for name, value := range services {
			if !composeServiceName.MatchString(name) {
				return errors.New("prebuild Compose service name is invalid")
			}
			service, ok := value.(map[string]any)
			if !ok {
				return errors.New("prebuild Compose service is invalid")
			}
			for field, value := range service {
				if field == "environment" {
					continue
				}
				if err := admitComposePrebuildStrings(map[string]any{field: value}); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func admitComposePrebuildStrings(value any) error {
	switch value := value.(type) {
	case string:
		if composeEnvironmentReference.MatchString(strings.ReplaceAll(value, "$$", "")) {
			return errors.New("prebuild Compose cannot depend on the producer environment")
		}
	case []any:
		for _, entry := range value {
			if err := admitComposePrebuildStrings(entry); err != nil {
				return err
			}
		}
	case map[string]any:
		for key, entry := range value {
			if err := admitComposePrebuildStrings(key); err != nil {
				return err
			}
			if err := admitComposePrebuildStrings(entry); err != nil {
				return err
			}
		}
	}
	return nil
}
