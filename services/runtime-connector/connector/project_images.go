package connector

import (
	"context"
	_ "crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	imagereference "github.com/distribution/reference"
)

const maxProjectImages = 8

func requirePreparedProjectImages(prepared, current []string) error {
	keys := func(references []string) (map[string]bool, error) {
		result := make(map[string]bool, len(references))
		for _, reference := range references {
			key, err := projectReferenceKey(reference)
			if err != nil {
				return nil, err
			}
			result[key] = true
		}
		return result, nil
	}
	expected, err := keys(prepared)
	if err != nil {
		return err
	}
	observed, err := keys(current)
	if err != nil {
		return err
	}
	if len(expected) != len(observed) {
		return errors.New("Project image inputs changed during preparation; start compute again")
	}
	for key := range expected {
		if !observed[key] {
			return errors.New("Project image inputs changed during preparation; start compute again")
		}
	}
	return nil
}

// Each Workspace owns its daemon. Reuse confirmed immutable images there, never
// another Workspace's Docker graph, mutable dependency tree or verification result.
func prepareProjectImages(parent context.Context, references []string) error {
	return prepareProjectImagesWith(parent, references, acquireProjectImage)
}

func prepareProjectImagesWith(parent context.Context, references []string, acquire func(context.Context, string) error) error {
	unique := make([]string, 0, len(references))
	seen := make(map[string]bool, len(references))
	for _, reference := range references {
		key, err := projectReferenceKey(reference)
		if err != nil {
			return err
		}
		if !seen[key] {
			seen[key] = true
			unique = append(unique, reference)
		}
	}
	if len(unique) > maxProjectImages {
		return errors.New("Project declares more than eight image inputs")
	}
	if err := parent.Err(); err != nil {
		return errors.New("Project image preparation was cancelled")
	}
	if len(unique) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, 180*time.Second)
	defer cancel()
	jobs := make(chan string, len(unique))
	for _, reference := range unique {
		jobs <- reference
	}
	close(jobs)
	var workers sync.WaitGroup
	var firstError error
	var failure sync.Once
	for range min(2, len(unique)) {
		workers.Go(func() {
			for reference := range jobs {
				if ctx.Err() != nil {
					return
				}
				if err := acquire(ctx, reference); err != nil {
					failure.Do(func() {
						firstError = err
						cancel()
					})
					return
				}
			}
		})
	}
	workers.Wait()
	if firstError != nil {
		return firstError
	}
	if ctx.Err() != nil {
		return errors.New("Project image preparation was cancelled or exceeded 180 seconds")
	}
	return nil
}

func acquireProjectImage(ctx context.Context, reference string) error {
	expected, err := projectImageKey(reference)
	mutable := err != nil
	if mutable {
		if _, err := projectReferenceKey(reference); err != nil {
			return err
		}
	}
	confirmed := func() bool {
		output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{json .RepoDigests}}", reference).Output()
		if len(output) > 64<<10 {
			return false
		}
		var digests []string
		if err != nil || json.Unmarshal(output, &digests) != nil {
			return false
		}
		for _, digest := range digests {
			observed, err := projectImageKey(digest)
			if err == nil && observed == expected {
				return true
			}
		}
		return false
	}
	if !mutable && confirmed() {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return errors.New("Project image preparation was cancelled")
	}
	// Registry output is neither product state nor an actionable user diagnostic.
	if runtimeDockerCommand(ctx, "pull", reference).Run() != nil {
		if ctx.Err() != nil {
			return errors.New("Project image preparation was cancelled or exceeded 180 seconds")
		}
		return errors.New("Project image download failed; check registry connectivity and approved CA trust")
	}
	if mutable {
		_, err := resolveProjectImage(ctx, reference)
		return err
	}
	if !confirmed() {
		return errors.New("Project image exact digest was not confirmed after download")
	}
	return nil
}

func projectReferenceKey(value string) (string, error) {
	if key, err := projectImageKey(value); err == nil {
		return key, nil
	}
	if strings.HasPrefix(value, "sha256:") || strings.ContainsAny(value, " \t\r\n") {
		return "", errors.New("Project image registry reference is invalid")
	}
	named, err := imagereference.ParseNormalizedNamed(value)
	if err != nil {
		return "", errors.New("Project image registry reference is invalid")
	}
	return imagereference.TagNameOnly(named).String(), nil
}

func resolveProjectImage(ctx context.Context, reference string) (string, error) {
	named, err := imagereference.ParseNormalizedNamed(reference)
	if err != nil {
		return "", errors.New("Project image registry reference is invalid")
	}
	output, err := runtimeDockerCommand(ctx, "image", "inspect", "--format", "{{json .RepoDigests}}", reference).Output()
	var digests []string
	if err != nil || len(output) > 64<<10 || json.Unmarshal(output, &digests) != nil {
		return "", errors.New("Project image resolved digest is unavailable")
	}
	for _, digest := range digests {
		key, err := projectImageKey(digest)
		if err == nil && strings.HasPrefix(key, imagereference.TrimNamed(named).Name()+"@") {
			return key, nil
		}
	}
	return "", errors.New("Project image resolved digest is unavailable")
}

func projectImageKey(value string) (string, error) {
	if !browserImagePattern.MatchString(value) || strings.HasPrefix(value, "sha256:") {
		return "", errors.New("Project images must use registry references pinned by exact digest")
	}
	named, err := imagereference.ParseNormalizedNamed(value)
	if err != nil {
		return "", errors.New("Project image registry reference is invalid")
	}
	canonical, ok := named.(imagereference.Canonical)
	if !ok {
		return "", errors.New("Project images must use registry references pinned by exact digest")
	}
	return imagereference.TrimNamed(named).Name() + "@" + canonical.Digest().String(), nil
}
