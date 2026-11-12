// Run with `go -C PINNED_SUBSTRATE run -mod=vendor /absolute/path/schema-check.go ...`.
// This checks real rendered files against upstream Go/protobuf wire schemas.
// It is not Kubernetes CEL/admission or an installed Actor qualification.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	ateapi "go.ate.dev/substrate/api/ateapi/v1"
	ate "go.ate.dev/substrate/api/infra/k8s/ate/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func read(directory, name string) []byte {
	data, err := os.ReadFile(filepath.Join(directory, name+".json"))
	must(err)
	return data
}

func strict(data []byte, target any) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	must(decoder.Decode(target))
}

func main() {
	if len(os.Args) != 3 {
		panic("expected pinned source and rendered directory")
	}
	directory := os.Args[2]
	var sandbox ate.SandboxConfig
	strict(read(directory, "sandboxConfig"), &sandbox)
	var pool ate.WorkerPool
	strict(read(directory, "workerPool"), &pool)
	var template ateapi.ActorTemplate
	must(protojson.Unmarshal(read(directory, "actorTemplate"), &template))
	if sandbox.Spec.DefaultVersion != pool.Spec.SandboxClasses[0].ConfigRef.Name ||
		template.SnapshotConfig.PreferredFidelity != ateapi.SnapshotFidelity_SNAPSHOT_FIDELITY_ROOTFS ||
		pool.Spec.Replicas != 1 {
		panic("incorrect runtime binding, ROOTFS fidelity or fixed pool capacity")
	}
	fmt.Println("PASS: rendered SandboxConfig/WorkerPool strict upstream Go decode; ActorTemplate strict upstream protobuf decode; runtime/ROOTFS binding")
}
