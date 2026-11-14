package connector

import "errors"

// Only the native Parent's internal dependency image may bypass Registry
// acquisition. Source-authored image IDs use ordinary reference admission.
func (assignment Assignment) registryProjectImages(images []string) ([]string, bool, error) {
	if assignment.preparedRootFSImage == "" {
		return images, false, nil
	}
	if assignment.nativeActorUID == "" || !prebuildImageID.MatchString(assignment.preparedRootFSImage) {
		return nil, false, errors.New("native dependency image identity is invalid")
	}
	registry := make([]string, 0, len(images))
	found := false
	unique := make(map[string]bool)
	for _, image := range images {
		key := image
		nativeReference := false
		if assignment.nativeDependencyReference != "" {
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
