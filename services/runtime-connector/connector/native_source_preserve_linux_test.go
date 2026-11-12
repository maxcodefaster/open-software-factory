package connector

import (
	"bytes"
	"testing"
)

func TestNativeSourcePreservationRefusesOrdinaryHostRootAndWrongNamespace(t *testing.T) {
	var output bytes.Buffer
	if err := RunSubstrateSourcePreserve("233069a6-2766-4db2-b020-0814f937abb0", "c61f65ba-443f-4ef0-8677-85ed7f4a3063", &output); err == nil {
		t.Fatal("preservation ran without the exact private RootlessKit mapping and Actor projection")
	}
	if output.Len() != 0 {
		t.Fatal("denied preservation published a recovery identity")
	}
	if view, cleanup, err := nativeArchiveView("/home/rootless/persist/connector/source-archive-view"); err == nil {
		view.Close()
		cleanup()
		t.Fatal("archive view was mounted outside the exact private RootlessKit identity")
	}
	if err := RunSubstrateSourcePreserveReconciled("233069a6-2766-4db2-b020-0814f937abb0", "c61f65ba-443f-4ef0-8677-85ed7f4a3063", "", &output); err == nil {
		t.Fatal("reconciliation admitted an unknown predecessor")
	}
	if err := RunSubstrateSourcePreserveReconciled("233069a6-2766-4db2-b020-0814f937abb0", "c61f65ba-443f-4ef0-8677-85ed7f4a3063", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &output); err == nil {
		t.Fatal("reconciliation ran without exact private identity and completed archive")
	}
}
