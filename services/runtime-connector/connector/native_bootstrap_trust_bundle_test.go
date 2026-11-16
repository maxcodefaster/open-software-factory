package connector

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeBootstrapTrustPublishesBothPublicRootsAndParentOnlyReusesExactBundle(t *testing.T) {
	native, nativeCA := bootstrapTrustServer(t, "native roots")
	factory, factoryCA := bootstrapTrustServer(t, "Factory")
	unrelated, _ := bootstrapTrustServer(t, "unrelated")
	directory := filepath.Join(t.TempDir(), "connector")
	beforeNative, beforeFactory := bytes.Clone(nativeCA), bytes.Clone(factoryCA)
	if _, err := nativeBootstrapTrust(directory, nativeCA, string(factoryCA), false); err == nil {
		t.Fatal("readiness/Parent created missing cold trust")
	}
	path, err := nativeBootstrapTrust(directory, nativeCA, string(factoryCA), true)
	if err != nil {
		t.Fatal(err)
	}
	if path != filepath.Join(directory, "trust.pem") ||
		nativeBootstrapTrustProjection != "/run/ate/egress-trust-bundle/trust-bundle.pem" ||
		nativeBootstrapStateDirectory != "/home/rootless/persist/connector" {
		t.Fatal("native bootstrap trust changed its fixed paths")
	}
	combined, err := os.ReadFile(path)
	expected := append(append(bytes.Clone(nativeCA), '\n'), factoryCA...)
	if err != nil || !bytes.Equal(combined, expected) ||
		!bytes.Equal(nativeCA, beforeNative) || !bytes.Equal(factoryCA, beforeFactory) {
		t.Fatal("bootstrap replaced native roots or modified frozen public inputs")
	}
	for path, mode := range map[string]os.FileMode{directory: os.ModeDir | 0700, path: 0600} {
		info, err := os.Lstat(path)
		if err != nil || info.Mode() != mode {
			t.Fatalf("private trust permissions differ: %s %v %v", path, info, err)
		}
	}
	client, err := bootstrapTrustClient(path)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	for _, endpoint := range []string{native.URL, factory.URL} {
		response, err := client.Get(endpoint)
		if err != nil {
			t.Fatal("combined cold trust lost an admitted TLS root:", err)
		}
		response.Body.Close()
	}
	if response, err := client.Get(unrelated.URL); err == nil {
		response.Body.Close()
		t.Fatal("cold trust accepted an unadmitted TLS root")
	}
	original, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, prepare := range []bool{false, true, false} {
		if selected, err := nativeBootstrapTrust(directory, nativeCA, string(factoryCA), prepare); err != nil || selected != path {
			t.Fatalf("same cold trust could not be reused: %q %v", selected, err)
		}
	}
	retained, err := os.Stat(path)
	if err != nil || !os.SameFile(original, retained) || original.ModTime() != retained.ModTime() {
		t.Fatal("readiness/Parent rewrote the daemon's selected bundle")
	}
	_, nextCA := bootstrapTrustServer(t, "next frozen Factory CA")
	if _, err := nativeBootstrapTrust(directory, nativeCA, string(nextCA), false); err == nil {
		t.Fatal("Parent adopted another frozen Factory CA")
	}
	if _, err := nativeBootstrapTrust(directory, nativeCA, string(nextCA), true); err != nil {
		t.Fatal("cold step could not replace owned stale trust:", err)
	}
	rotated, err := os.ReadFile(path)
	if err != nil || bytes.Contains(rotated, factoryCA) || !bytes.Contains(rotated, nativeCA) || !bytes.Contains(rotated, nextCA) {
		t.Fatal("cold trust accumulated a previous Factory CA or lost native roots")
	}
}

func TestNativeBootstrapTrustRejectsInvalidOrPrivateInputsBeforeWriting(t *testing.T) {
	certificate := prebuildTrustCertificate(t, "public bootstrap CA")
	private := []byte("-----BEGIN PRIVATE KEY-----\nnever-copy-this\n-----END PRIVATE KEY-----\n")
	for name, invalid := range map[string][]byte{
		"empty": nil, "whitespace": []byte(" \n"), "invalid-DER": []byte("-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n"),
		"private-key": private, "public-and-private": append(bytes.Clone(certificate), private...),
		"junk-before":           append([]byte("not a certificate\n"), certificate...),
		"junk-after":            append(bytes.Clone(certificate), []byte("not a certificate\n")...),
		"skipped-malformed-PEM": append([]byte("-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n"), certificate...),
		"too-large":             bytes.Repeat([]byte("x"), nativeBootstrapTrustLimit+1),
	} {
		for _, invalidNative := range []bool{true, false} {
			t.Run(name+map[bool]string{true: "/native", false: "/Factory"}[invalidNative], func(t *testing.T) {
				directory := filepath.Join(t.TempDir(), "connector")
				native, factory := certificate, certificate
				if invalidNative {
					native = invalid
				} else {
					factory = invalid
				}
				if _, err := nativeBootstrapTrust(directory, native, string(factory), true); err == nil {
					t.Fatal("invalid/private trust was published")
				}
				if _, err := os.Lstat(directory); !os.IsNotExist(err) {
					t.Fatal("rejected trust changed private state")
				}
			})
		}
	}
}

func TestNativeBootstrapTrustRefusesUnsafeRetainedPathsWithoutRepair(t *testing.T) {
	certificate := prebuildTrustCertificate(t, "public bootstrap CA")
	for _, scenario := range []string{
		"directory-symlink", "public-directory", "file-symlink", "public-file", "file-directory", "hardlink",
		"foreign-directory", "foreign-file",
	} {
		t.Run(scenario, func(t *testing.T) {
			if (scenario == "foreign-directory" || scenario == "foreign-file") && os.Geteuid() != 0 {
				t.Skip("foreign UID fixture requires Linux/root proof")
			}
			root := t.TempDir()
			directory := filepath.Join(root, "connector")
			if err := os.Mkdir(directory, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(directory, "trust.pem")
			target := filepath.Join(root, "unrelated")
			if err := os.WriteFile(target, []byte("unrelated data"), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			switch scenario {
			case "directory-symlink":
				err = os.Remove(directory)
				if err == nil {
					err = os.Symlink(root, directory)
				}
				path = directory
			case "public-directory":
				err, path = os.Chmod(directory, 0755), directory
			case "file-symlink":
				err = os.Symlink(target, path)
			case "public-file":
				err = os.WriteFile(path, certificate, 0644)
			case "file-directory":
				err = os.Mkdir(path, 0600)
			case "hardlink":
				err = os.Link(target, path)
			case "foreign-directory":
				err, path = os.Chown(directory, 1000, 1000), directory
			case "foreign-file":
				err = os.WriteFile(path, certificate, 0600)
				if err == nil {
					err = os.Chown(path, 1000, 1000)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			original, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, prepare := range []bool{false, true} {
				if _, err := nativeBootstrapTrust(directory, certificate, string(certificate), prepare); err == nil {
					t.Fatal("unsafe retained trust was accepted")
				}
			}
			retained, err := os.Lstat(path)
			if err != nil || !os.SameFile(original, retained) || original.Mode() != retained.Mode() {
				t.Fatal("unsafe retained trust was changed instead of refused")
			}
			data, err := os.ReadFile(target)
			if err != nil || string(data) != "unrelated data" {
				t.Fatal("unrelated trust target was changed")
			}
		})
	}
}

func TestNativeBootstrapTrustParentRefusesMissingOrAlteredBundle(t *testing.T) {
	certificate := prebuildTrustCertificate(t, "public bootstrap CA")
	directory := filepath.Join(t.TempDir(), "connector")
	path, err := nativeBootstrapTrust(directory, certificate, string(certificate), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, content := range [][]byte{certificate, []byte("invalid retained trust")} {
		if err := os.WriteFile(path, content, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := nativeBootstrapTrust(directory, certificate, string(certificate), false); err == nil {
			t.Fatal("Parent accepted a different bundle from dockerd")
		}
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := nativeBootstrapTrust(directory, certificate, string(certificate), false); err == nil {
		t.Fatal("Parent recreated missing daemon trust")
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only trust selection changed state")
	}
}
