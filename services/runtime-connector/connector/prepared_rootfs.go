package connector

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

const preparedRootFSLabel = "factory.dev/prepared-rootfs"

// Capture only the clean primary, before App activation or Runtime grants.
// Docker excludes its mounts: the Fork's separate checkout remains authoritative.
// The private image stays inside this Sandbox's daemon and is never published.
func (project *preparedProject) captureRootFS(ctx context.Context) error {
	if err := validatePreparedProject(project.assignment); err != nil {
		return err
	}
	if _, err := project.observe(); err != nil {
		return err
	}
	tag := "factory-prepared-rootfs:" + project.assignment.RuntimeAttemptID
	// The native Sandbox preparation already owns this operation. Give its
	// private cache a deterministic name so lost output is observed, not replayed.
	existing, err := exec.CommandContext(ctx, "docker", "image", "ls", "--quiet",
		"--no-trunc", "--filter", "reference="+tag).Output()
	if err != nil {
		return errors.New("prepared primary cache observation is unavailable")
	}
	if strings.TrimSpace(string(existing)) == "" {
		// Commit pauses the primary for its filesystem capture. It does not
		// capture memory or bring Runtime credentials into the clean container.
		_ = exec.CommandContext(ctx, "docker", "commit", "--pause=true",
			"--change", "LABEL "+preparedRootFSLabel+"="+project.result.ContainerID,
			project.result.ContainerID, tag).Run()
	}
	image, err := project.inspectRootFS(ctx, tag)
	if err != nil {
		return err
	}
	project.rootFSImage = image
	return nil
}

func (project *preparedProject) inspectRootFS(ctx context.Context, reference string) (string, error) {
	output, err := exec.CommandContext(ctx, "docker", "image", "inspect", reference).Output()
	var images []prebuildImage
	if err != nil || len(output) > 1<<20 || json.Unmarshal(output, &images) != nil ||
		len(images) != 1 || !prebuildImageID.MatchString(images[0].ID) ||
		images[0].Config.Labels[preparedRootFSLabel] != project.result.ContainerID ||
		images[0].Config.Labels[attemptLabel] != project.origin.AttemptID ||
		images[0].Config.Labels[generationLabel] != strconv.FormatUint(project.origin.Generation, 10) {
		return "", errors.New("prepared primary dependency image identity is unavailable or changed")
	}
	return images[0].ID, nil
}

// Only the internal, observed clean-primary image may bypass Registry acquisition.
// A source-authored image ID still goes through the ordinary reference admission.
func (assignment Assignment) registryProjectImages(images []string) ([]string, bool, error) {
	if assignment.preparedRootFSImage == "" {
		return images, false, nil
	}
	if !prebuildImageID.MatchString(assignment.preparedRootFSImage) {
		return nil, false, errors.New("prepared primary dependency image identity is invalid")
	}
	registry := make([]string, 0, len(images))
	found := false
	unique := make(map[string]bool)
	for _, image := range images {
		key := image
		nativeReference := false
		if assignment.nativeActorUID != "" && assignment.nativeDependencyReference != "" {
			candidate, candidateErr := projectReferenceKey(image)
			expected, expectedErr := projectReferenceKey(assignment.nativeDependencyReference)
			nativeReference = candidateErr == nil && expectedErr == nil && candidate == expected
		}
		if image == assignment.preparedRootFSImage || nativeReference {
			found = true
			key = assignment.preparedRootFSImage
		} else {
			var err error
			key, err = projectReferenceKey(image)
			if err != nil {
				return nil, false, err
			}
			registry = append(registry, image)
		}
		unique[key] = true
	}
	if len(unique) > maxProjectImages {
		return nil, false, errors.New("Project declares more than eight image inputs")
	}
	return registry, found, nil
}
