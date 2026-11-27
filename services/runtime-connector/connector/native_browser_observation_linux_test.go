package connector

import (
	"net/http"
	"testing"
)

func TestNativeBrowserInspectionRequiresCurrentNativeSourceIdentity(t *testing.T) {
	const actorUID = "6ec64223-9bdd-49e2-85a0-0cfa1f9a13d1"
	for _, variant := range []string{
		"exact", "foreign-actor", "unadmitted-actor", "nil-owner", "foreign-owner", "no-assigned-source",
		"not-ready", "no-service", "no-epoch", "foreign-path", "unclean-path", "foreign-control",
	} {
		t.Run(variant, func(t *testing.T) {
			source := &nativeSourceOwner{service: &nativeSourceService{Handler: http.NotFoundHandler()}}
			source.ready.Store(true)
			source.epoch.Store(1)
			assignment := Assignment{
				WorkspaceFolder: "/var/lib/factory/source/project", ConnectorStateDir: nativeBootstrapStateDirectory,
			}
			assignment.SetNativeActorUID(actorUID)
			assignment.SetNativeSource(source)
			currentActor := actorUID
			switch variant {
			case "foreign-actor":
				currentActor = "559d9659-2148-4df2-8263-0af82e2c979d"
			case "unadmitted-actor":
				assignment.SetNativeActorUID("")
			case "nil-owner":
				source = nil
			case "foreign-owner":
				assignment.SetNativeSource(&nativeSourceOwner{})
			case "no-assigned-source":
				assignment.SetNativeSource(nil)
			case "not-ready":
				source.ready.Store(false)
			case "no-service":
				source.service = nil
			case "no-epoch":
				source.epoch.Store(0)
			case "foreign-path":
				assignment.WorkspaceFolder = "/foreign/project"
			case "unclean-path":
				assignment.WorkspaceFolder += "/."
			case "foreign-control":
				assignment.ConnectorStateDir = "/foreign/control"
			}
			err := validateNativeBrowserInspectionSource(assignment, source, currentActor)
			if (err == nil) != (variant == "exact") {
				t.Fatalf("native Source identity check: %v", err)
			}
		})
	}
}

func TestNativeBrowserInspectionRejectsWrongScopeBeforeSourceAccess(t *testing.T) {
	assignment, _, message := browserInspectionFixture(t)
	message.Generation++
	reply := handleNativeBrowserInspection(t.Context(), assignment, nil, message)
	if reply.Error == "" || reply.Data != "" || reply.Type != "operation-response" ||
		reply.OperationID != message.OperationID || reply.Action != "browser-inspection" {
		t.Fatalf("unadmitted observation returned context or lost protocol identity: %+v", reply)
	}
}
