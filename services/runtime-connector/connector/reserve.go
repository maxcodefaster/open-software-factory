package connector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type ReserveSlot struct {
	Version   int         `json:"version"`
	ID        string      `json:"id"`
	Role      string      `json:"role"`
	Images    []string    `json:"images"`
	ExpiresAt time.Time   `json:"expiresAt"`
	Project   *Assignment `json:"project,omitempty"`
}

type ReserveActivation struct {
	SlotID      string     `json:"slotId"`
	PodUID      string     `json:"podUID"`
	Assignment  Assignment `json:"assignment"`
	ParentToken string     `json:"parentToken"`
	ChildToken  string     `json:"childToken"`
	TemplateID  string     `json:"templateId,omitempty"`
}

type reserveOutcome struct {
	SlotID     string `json:"slotId"`
	PodUID     string `json:"podUID"`
	AttemptID  string `json:"attemptID"`
	Generation uint64 `json:"generation"`
	Digest     string `json:"digest"`
}

func readReserveJSON(path string, destination any) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024*1024 {
		return nil, errors.New("execution slot data is not a bounded regular file")
	}
	content, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return nil, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("execution slot data has trailing content")
	}
	return content, nil
}

func validateReserveSlot(slot ReserveSlot) error {
	if slot.Version != 1 || !identityPattern.MatchString(slot.ID) || (slot.Role != "staging" && slot.Role != "verification") || len(slot.Images) > 3 || slot.ExpiresAt.IsZero() {
		return errors.New("execution slot preparation identity is invalid")
	}
	for _, image := range slot.Images {
		if !browserImagePattern.MatchString(image) {
			return errors.New("execution slot images must be immutable")
		}
	}
	if slot.Project != nil {
		if err := validatePreparedProject(*slot.Project); err != nil {
			return err
		}
		if slot.Project.RuntimeAttemptID != slot.ID || slot.Project.Generation != 1 {
			return errors.New("prepared Project belongs to another template")
		}
	}
	return nil
}

func validateReserveActivation(slot ReserveSlot, activation ReserveActivation) error {
	assignment := activation.Assignment
	correctSlot := activation.SlotID == slot.ID && activation.TemplateID == ""
	if slot.Project != nil {
		correctSlot = activation.TemplateID == slot.ID && activation.SlotID != slot.ID && identityPattern.MatchString(activation.SlotID)
	}
	if !correctSlot || activation.PodUID == "" || activation.ParentToken == "" || activation.ChildToken == "" {
		return errors.New("execution slot activation identity or capabilities are missing")
	}
	if err := assignment.Validate(); err != nil {
		return err
	}
	if assignment.WorkspaceFolder != "/home/coder/project" || assignment.RemoteWorkspaceFolder != "/workspace/project" || assignment.ConnectorStateDir != "/home/coder/connector-state" || assignment.PreserveWorkspace || assignment.BrowserToolsImage != "" {
		return errors.New("execution slot activation cannot replace retained source or change its storage boundary")
	}
	if slot.Project != nil && assignment.RepositoryIdentity != slot.Project.RepositoryIdentity {
		return errors.New("prepared Project cannot acquire another Project's capabilities")
	}
	for _, channel := range assignment.Channels {
		if (slot.Project != nil && channel.Kind != "app" && channel.Kind != "verification") ||
			(slot.Project == nil && ((slot.Role == "staging" && channel.Kind != "app") || (slot.Role == "verification" && channel.Kind != "verification"))) {
			return errors.New("execution slot activation role differs from prepared tools")
		}
	}
	return nil
}

func writeReserveOutcome(directory string, outcome reserveOutcome) error {
	content, err := json.Marshal(outcome)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(directory, ".outcome-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(0400); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(content); err != nil {
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
	if err := os.Rename(file.Name(), filepath.Join(directory, "activated.json")); err != nil {
		return err
	}
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func acceptReserveActivation(slot ReserveSlot, path string) (ReserveActivation, error) {
	var activation ReserveActivation
	content, err := readReserveJSON(path, &activation)
	if err != nil {
		return activation, err
	}
	if err := validateReserveActivation(slot, activation); err != nil {
		return activation, err
	}
	digest := sha256.Sum256(content)
	expected := reserveOutcome{SlotID: activation.SlotID, PodUID: activation.PodUID, AttemptID: activation.Assignment.RuntimeAttemptID, Generation: activation.Assignment.Generation, Digest: hex.EncodeToString(digest[:])}
	directory := filepath.Dir(path)
	var previous reserveOutcome
	_, err = readReserveJSON(filepath.Join(directory, "activated.json"), &previous)
	if err == nil {
		if previous != expected {
			return activation, errors.New("used execution slot cannot be reassigned")
		}
		return activation, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return activation, err
	}
	if slot.Project == nil {
		if _, err := os.Lstat(activation.Assignment.WorkspaceFolder); !errors.Is(err, os.ErrNotExist) {
			return activation, errors.New("unassigned execution slot already contains repository data")
		}
	} else if err := checkoutProject(context.Background(), *slot.Project); err != nil {
		return activation, fmt.Errorf("prepared Project is no longer clean: %w", err)
	}
	if _, err := os.Lstat(activation.Assignment.ConnectorStateDir); !errors.Is(err, os.ErrNotExist) {
		return activation, errors.New("unassigned execution slot already contains runtime state")
	}
	if err := writeReserveOutcome(directory, expected); err != nil {
		return activation, err
	}
	if err := os.Remove(filepath.Join(directory, "ready")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return activation, err
	}
	return activation, nil
}

func RunReserve(ctx context.Context, slotPath, activationPath string) error {
	var slot ReserveSlot
	if _, err := readReserveJSON(slotPath, &slot); err != nil {
		return fmt.Errorf("read execution slot: %w", err)
	}
	if err := validateReserveSlot(slot); err != nil {
		return err
	}
	if activationPath != "/home/coder/.factory-reserve/activation.json" {
		return errors.New("execution slot activation path is fixed")
	}
	directory := filepath.Dir(activationPath)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(directory); err != nil || !info.IsDir() {
		return errors.New("execution slot state directory is invalid")
	}
	lock, err := os.OpenFile(filepath.Join(directory, "wait.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return errors.New("execution slot already has an activation owner")
	}
	defer unix.Flock(int(lock.Fd()), unix.LOCK_UN)
	if err := waitForDocker(ctx); err != nil {
		return err
	}
	var project *preparedProject
	if _, err := os.Stat(activationPath); errors.Is(err, os.ErrNotExist) {
		for _, args := range [][]string{{"ps", "--all", "--quiet"}, {"volume", "ls", "--quiet"}} {
			output, err := exec.CommandContext(ctx, "docker", args...).Output()
			if err != nil || strings.TrimSpace(string(output)) != "" {
				return errors.New("execution reserve requires a clean private Docker daemon")
			}
		}
		preparation, cancel := context.WithTimeout(ctx, 3*time.Minute)
		err := prepareProjectImages(preparation, slot.Images)
		cancel()
		if err != nil {
			return err
		}
		if slot.Project != nil {
			project, err = prepareReservedProject(ctx, *slot.Project)
			if err != nil {
				return err
			}
			if err := waitPreparedDockerIdle(ctx); err != nil {
				return err
			}
		}
		if err := os.WriteFile(filepath.Join(directory, "ready"), []byte(slot.ID), 0400); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(activationPath); err == nil {
			if slot.Project != nil && project == nil {
				return errors.New("used prepared Project cannot boot as a fresh reserve")
			}
			activation, err := acceptReserveActivation(slot, activationPath)
			if err != nil {
				return err
			}
			return runParent(ctx, activation.Assignment, activation.ParentToken, activation.ChildToken, project)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		// Prepared Project clones retain the template's in-memory recipe.
		// Their individual unused-slot TTL is owned by Factory, not this
		// copied absolute template deadline.
		if slot.Project == nil && time.Now().After(slot.ExpiresAt) {
			return errors.New("unassigned execution slot expired")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
