package project

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yu7dan/perch/internal/uimsg"
)

func TestCreateFolderCreatesOneDirectory(t *testing.T) {
	parent := t.TempDir()
	got, err := CreateFolder(parent, "新项目")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	want := filepath.Join(parent, "新项目")
	if got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
	st, err := os.Stat(want)
	if err != nil || !st.IsDir() {
		t.Fatalf("created folder missing: st=%v err=%v", st, err)
	}
}

func TestCreateFolderRefusesExistingWithoutOverwriting(t *testing.T) {
	parent := t.TempDir()
	dest := filepath.Join(parent, "exists")
	if err := os.Mkdir(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := CreateFolder(parent, "exists")
	if err == nil {
		t.Fatal("expected an error for an existing folder")
	}
	if got != dest {
		t.Fatalf("path = %q, want %q", got, dest)
	}
	if code := uiCode(err); code != "project.createExists" {
		t.Fatalf("code = %q, want project.createExists", code)
	}
}

func TestCreateFolderRejectsFileAtTarget(t *testing.T) {
	parent := t.TempDir()
	dest := filepath.Join(parent, "same")
	if err := os.WriteFile(dest, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := CreateFolder(parent, "same")
	if err == nil {
		t.Fatal("expected an error for an existing file")
	}
	if got != dest {
		t.Fatalf("path = %q, want %q", got, dest)
	}
	if code := uiCode(err); code != "project.createFileExists" {
		t.Fatalf("code = %q, want project.createFileExists", code)
	}
}

func TestCreateFolderRejectsMissingParent(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "missing")
	_, err := CreateFolder(parent, "child")
	if err == nil {
		t.Fatal("expected an error for a missing parent")
	}
	if code := uiCode(err); code != "project.createParentMissing" {
		t.Fatalf("code = %q, want project.createParentMissing", code)
	}
}

func TestCreateFolderRejectsParentFile(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(parent, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := CreateFolder(parent, "child")
	if err == nil {
		t.Fatal("expected an error for a file parent")
	}
	if code := uiCode(err); code != "project.createParentNotDir" {
		t.Fatalf("code = %q, want project.createParentNotDir", code)
	}
}

func TestCreateFolderNameValidation(t *testing.T) {
	cases := []string{
		"", ".", "..", `a/b`, `a\b`, `a:b`, `a*b`, `a?b`, `a"b`, "a<b", "a>b", "a|b",
		"trail.", "CON", "con.txt", "NUL", "COM1", "LPT9",
		"bad\x01name",
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := CreateFolder(t.TempDir(), name)
			if err == nil {
				t.Fatalf("expected %q to be rejected", name)
			}
			code := uiCode(err)
			if code != "project.createNameEmpty" && !strings.HasPrefix(code, "project.createInvalidName") {
				t.Fatalf("code = %q, want project.createNameEmpty/project.createInvalidName", code)
			}
		})
	}
}

func TestCreateFolderTrimsOuterSpaces(t *testing.T) {
	parent := t.TempDir()
	got, err := CreateFolder(parent, "  trimmed  ")
	if err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}
	if want := filepath.Join(parent, "trimmed"); got != want {
		t.Fatalf("path = %q, want %q", got, want)
	}
}

func TestCreateFolderAllowsNormalNames(t *testing.T) {
	for _, name := range []string{"my-project", "项目 2", "a.b", "space inside"} {
		t.Run(name, func(t *testing.T) {
			if _, err := CreateFolder(t.TempDir(), name); err != nil {
				t.Fatalf("CreateFolder(%q): %v", name, err)
			}
		})
	}
}

func uiCode(err error) string {
	var target *uimsg.Error
	if errors.As(err, &target) {
		return target.Code
	}
	return ""
}
