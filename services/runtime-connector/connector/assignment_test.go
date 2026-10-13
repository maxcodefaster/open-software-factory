package connector

import "testing"

func validAssignment() Assignment {
	return Assignment{
		Version:               AssignmentVersion,
		RuntimeAttemptID:      "runtime-test",
		Generation:            1,
		WorkspaceFolder:       "/workspace/outer",
		RemoteWorkspaceFolder: "/workspace/project",
		RepositoryURL:         "file:///factory/source/project.bundle",
		RepositoryIdentity:    "20e65e28-8bad-4c05-a063-3b629808d549",
		Revision:              "main",
		DevcontainerPath:      ".devcontainer/devcontainer.json",
		ComposeProjectName:    "runtime-test",
		ControlURL:            "wss://factory.example.test/runtime/connect",
		Channels: []Channel{{
			Name:       "app",
			Kind:       "app",
			Target:     "http://127.0.0.1:4300",
			HealthPath: "/health",
		}},
	}
}

func TestAssignmentValidation(t *testing.T) {
	assignment := validAssignment()
	if err := assignment.Validate(); err != nil {
		t.Fatalf("valid assignment failed: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*Assignment)
	}{
		{"traversing Dev Container path", func(value *Assignment) { value.DevcontainerPath = "../devcontainer.json" }},
		{"remote target", func(value *Assignment) { value.Channels[0].Target = "http://example.com:4300" }},
		{"control URL credentials", func(value *Assignment) { value.ControlURL = "wss://token@factory.example.test/connect" }},
		{"duplicate channel", func(value *Assignment) { value.Channels = append(value.Channels, value.Channels[0]) }},
		{"missing generation", func(value *Assignment) { value.Generation = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			candidate := validAssignment()
			test.mutate(&candidate)
			if err := candidate.Validate(); err == nil {
				t.Fatal("invalid assignment passed validation")
			}
		})
	}
}

func TestProtectProcess(t *testing.T) {
	if err := ProtectProcess(); err != nil {
		t.Fatalf("protect process: %v", err)
	}
}

func TestAgentChannelAndProcessEnvironment(t *testing.T) {
	assignment := validAssignment()
	assignment.Channels = append(assignment.Channels, Channel{
		Name: "agent", Kind: "agent", Target: "http://127.0.0.1:4096", HealthPath: "/global/health",
	})
	assignment.Processes = []Process{{
		Name: "agent", Command: []string{"opencode", "serve"}, Env: map[string]string{"FACTORY_MODEL_TOKEN": "token"},
	}}
	if err := assignment.Validate(); err != nil {
		t.Fatalf("agent assignment failed: %v", err)
	}
	assignment.Processes[0].Env["INVALID NAME"] = "value"
	if err := assignment.Validate(); err == nil {
		t.Fatal("invalid process environment passed validation")
	}
}
