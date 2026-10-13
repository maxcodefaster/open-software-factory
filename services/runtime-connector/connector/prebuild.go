package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const prebuildCLIIntegrity = "sha512-LzaoOGKQ/Zql6PsiZ4hVIYVZagzWkD65aG/1ou5/Kly5Y1PtjLg1yn7qu+LZCzVoAl6DZZ/pbz8qOO4RLNlqMg=="
const prebuildCLIVersion = "0.89.0"
const prebuildLabel = "factory.dev/prebuild-input"

var prebuildCommit = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)
var prebuildImageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
var errPrebuildImageUnavailable = errors.New("prebuild image is unavailable")

// The producer runs only in an assigned Envbox's private daemon. Consumers use
// the returned ordinary registry digest in their normal Dev Container recipe.
type PrebuildRequest struct {
	Commit          string `json:"commit"`
	Platform        string `json:"platform"`
	ImageRepository string `json:"imageRepository"`
	Configuration   string `json:"configuration,omitempty"`
}

type PrebuildResult struct {
	Identity string `json:"identity"`
	Image    string `json:"image"`
}

type prebuildInput struct {
	Version            int      `json:"version"`
	Repository         string   `json:"repository"`
	Commit             string   `json:"commit"`
	Tree               string   `json:"tree"`
	Configuration      string   `json:"configuration"`
	Dockerfile         string   `json:"dockerfile,omitempty"`
	Platform           string   `json:"platform"`
	ImageRepository    string   `json:"imageRepository"`
	CLIVersion         string   `json:"cliVersion"`
	CLIIntegrity       string   `json:"cliIntegrity"`
	ImmutableInputs    []string `json:"immutableInputs"`
	EnvironmentVersion uint64   `json:"environmentVersion"`
}

type prebuildIntent struct {
	Identity        string        `json:"identity"`
	Input           prebuildInput `json:"input"`
	CreatingAttempt string        `json:"creatingAttempt"`
	ImageID         string        `json:"imageId,omitempty"`
	Image           string        `json:"image,omitempty"`
}

type prebuildOperation struct {
	Identity  string
	Directory string
	Tag       string
	Input     prebuildInput
}

type prebuildConfiguration struct {
	Document          json.RawMessage `json:"-"`
	Image             string          `json:"image"`
	Dockerfile        string          `json:"dockerFile"`
	DockerComposeFile any             `json:"dockerComposeFile"`
	Build             struct {
		Dockerfile string `json:"dockerfile"`
		Context    string `json:"context"`
	} `json:"build"`
	Features                  map[string]json.RawMessage `json:"features"`
	FactoryEnvironmentVersion uint64                     `json:"factoryEnvironmentVersion,omitempty"`
}

type prebuildConfigurationReader func(context.Context, string, string) (prebuildConfiguration, error)

func prebuildIdentity(input prebuildInput) string {
	encoded, _ := json.Marshal(input)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func writePrebuildIntent(directory string, intent prebuildIntent) error {
	encoded, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".intent-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(file.Name(), filepath.Join(directory, "intent.json")); err != nil {
		return err
	}
	parent, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer parent.Close()
	return parent.Sync()
}

func ProducePrebuild(parent context.Context, assignment Assignment, request PrebuildRequest) (PrebuildResult, error) {
	result, err := producePrebuildWith(parent, assignment, request, buildProjectPrebuild, pushProjectPrebuild, readPrebuildConfiguration)
	if err == nil {
		_ = trimPrivateBuildCache(parent)
	}
	return result, err
}

func producePrebuildWith(parent context.Context, assignment Assignment, request PrebuildRequest,
	build func(context.Context, prebuildOperation, string) (string, error), push func(context.Context, prebuildOperation, string) (string, error), read prebuildConfigurationReader) (PrebuildResult, error) {
	var result PrebuildResult
	ctx, cancel := context.WithTimeout(parent, 10*time.Minute)
	defer cancel()
	root, err := prebuildRoot(assignment)
	if err != nil {
		return result, err
	}
	fd, err := unix.Open(filepath.Join(root, "producer.lock"), unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return result, errors.New("prebuild lock is unavailable")
	}
	lock := os.NewFile(uintptr(fd), "prebuild-lock")
	defer lock.Close()
	for {
		err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) {
			return result, err
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer unix.Flock(fd, unix.LOCK_UN)
	input, snapshot, err := preparePrebuildInputWith(ctx, assignment, request, read)
	if err != nil {
		return result, err
	}
	defer os.RemoveAll(filepath.Dir(snapshot))
	identity := prebuildIdentity(input)
	operation := prebuildOperation{Identity: identity, Directory: filepath.Join(root, identity), Input: input}
	if err := os.Mkdir(operation.Directory, 0700); err != nil && !os.IsExist(err) {
		return result, err
	}
	info, err := os.Lstat(operation.Directory)
	if err != nil || !info.IsDir() {
		return result, errors.New("prebuild operation directory is unsafe")
	}
	if assignment.RuntimeAttemptID == "" || len(assignment.RuntimeAttemptID) > 64 {
		return result, errors.New("prebuild requires its persisted creating Runtime Attempt")
	}
	intent := prebuildIntent{Identity: identity, Input: input, CreatingAttempt: assignment.RuntimeAttemptID}
	path := filepath.Join(operation.Directory, "intent.json")
	if encoded, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(encoded, &intent) != nil || intent.Identity != identity || prebuildIdentity(intent.Input) != identity || intent.CreatingAttempt == "" || len(intent.CreatingAttempt) > 64 {
			return result, errors.New("persisted prebuild intent differs")
		}
	} else if !os.IsNotExist(err) {
		return result, err
	} else if err := writePrebuildIntent(operation.Directory, intent); err != nil {
		return result, err
	}
	// Separate producers have separate private graphs and may yield different
	// manifests for the same recipe. Scope their publication names to the first
	// persisted Attempt, then retain that name through compute restarts.
	scope := sha256.Sum256([]byte(intent.CreatingAttempt))
	operation.Tag = input.ImageRepository + ":factory-prebuild-" + identity + "-" + hex.EncodeToString(scope[:8])
	if intent.Image != "" {
		key, err := projectImageKey(intent.Image)
		if err != nil || !strings.HasPrefix(key, input.ImageRepository+"@") {
			return result, errors.New("persisted prebuild result differs")
		}
		return PrebuildResult{identity, intent.Image}, nil
	}
	if intent.ImageID == "" {
		intent.ImageID, err = build(ctx, operation, snapshot)
		if err != nil {
			return result, err
		}
		if !prebuildImageID.MatchString(intent.ImageID) {
			return result, errors.New("prebuild local image identity is invalid")
		}
		if err := writePrebuildIntent(operation.Directory, intent); err != nil {
			return result, err
		}
	}
	intent.Image, err = push(ctx, operation, intent.ImageID)
	if err != nil {
		return result, err
	}
	key, err := projectImageKey(intent.Image)
	if err != nil || !strings.HasPrefix(key, input.ImageRepository+"@") {
		return result, errors.New("prebuild push did not confirm the exact Project repository")
	}
	if err := writePrebuildIntent(operation.Directory, intent); err != nil {
		return result, err
	}
	return PrebuildResult{identity, intent.Image}, nil
}
