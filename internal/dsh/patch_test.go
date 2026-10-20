package dsh

import (
	"strings"
	"testing"
)

const testHooks = `C:\Users\dev\.claude\dsh-hooks.json`

func TestApplyManagedPatchToEmptyFile(t *testing.T) {
	out, err := ApplyManagedPatch("", testHooks)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, ManagedStartMarker) || !strings.Contains(out, ManagedEndMarker) {
		t.Fatalf("missing managed markers:\n%s", out)
	}
	if !strings.Contains(out, "configPath: 'C:\\Users\\dev\\.claude\\dsh-hooks.json'") {
		t.Fatalf("missing quoted configPath:\n%s", out)
	}
	got, found := ReadManagedHooksPath(out)
	if !found || got != testHooks {
		t.Fatalf("ReadManagedHooksPath = %q, %v", got, found)
	}
}

func TestApplyManagedPatchDropsEmptyFlowSequence(t *testing.T) {
	in := "# user note\n[]\n"
	out, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "\n[]\n") || strings.HasPrefix(out, "[]") {
		t.Fatalf("empty flow sequence should be dropped before appending block:\n%s", out)
	}
	if !strings.HasPrefix(out, "# user note\n") {
		t.Fatalf("user comment should be preserved:\n%s", out)
	}
}

func TestApplyManagedPatchPreservesUserRows(t *testing.T) {
	in := "- id: user-row\n  name: '@example/plugin'\n"
	out, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(out, in) {
		t.Fatalf("user rows should stay at the top:\n%s", out)
	}
	if !strings.Contains(out, "- id: "+ManagedRowID) {
		t.Fatalf("managed row missing:\n%s", out)
	}
}

func TestApplyManagedPatchReplacesExistingBlockOnly(t *testing.T) {
	first, err := ApplyManagedPatch("- id: user-row\n", `C:\old\hooks.json`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ApplyManagedPatch(first, `C:\new\hooks.json`)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(second, ManagedStartMarker) != 1 || strings.Count(second, ManagedEndMarker) != 1 {
		t.Fatalf("expected exactly one managed block:\n%s", second)
	}
	if !strings.Contains(second, `C:\new\hooks.json`) || strings.Contains(second, `C:\old\hooks.json`) {
		t.Fatalf("block was not replaced:\n%s", second)
	}
	if !strings.HasPrefix(second, "- id: user-row\n") {
		t.Fatalf("user row was lost:\n%s", second)
	}
}

func TestApplyManagedPatchRefusesNonEmptyFlowSequence(t *testing.T) {
	in := "[{id: user}, {id: other}]\n"
	out, err := ApplyManagedPatch(in, testHooks)
	if err != ErrUnappendablePatch {
		t.Fatalf("err = %v, want ErrUnappendablePatch", err)
	}
	if out != "" {
		t.Fatalf("on refusal the output must be empty, got %q", out)
	}
}

func TestRemoveManagedPatchRestoresEmptySequence(t *testing.T) {
	in := "# user note\n[]\n"
	withBlock, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	removed, changed := RemoveManagedPatch(withBlock)
	if !changed {
		t.Fatal("expected changed=true")
	}
	if strings.Contains(removed, ManagedStartMarker) {
		t.Fatalf("managed block still present:\n%s", removed)
	}
	if !strings.Contains(removed, "[]") {
		t.Fatalf("empty sequence should be restored:\n%s", removed)
	}
	if !strings.Contains(removed, "# user note") {
		t.Fatalf("user comment lost:\n%s", removed)
	}
}

func TestRemoveManagedPatchKeepsUserRows(t *testing.T) {
	in := "- id: user-row\n  name: '@example/plugin'\n"
	withBlock, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	removed, changed := RemoveManagedPatch(withBlock)
	if !changed {
		t.Fatal("expected changed=true")
	}
	if removed != "- id: user-row\n  name: '@example/plugin'\n" {
		t.Fatalf("user rows should be exactly preserved:\n%q", removed)
	}
}

func TestOrphanStartMarkerDoesNotSwallowLaterBlock(t *testing.T) {
	// 中断的写入留下一个没有 END 的 START；后面才是完整的一块。
	in := ManagedStartMarker + "\n- id: orphan\n" +
		"- id: user-row\n" +
		ManagedStartMarker + "\n- insert:\n    - id: x\n" + ManagedEndMarker + "\n"
	out, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "- id: user-row") || !strings.Contains(out, "- id: orphan") {
		t.Fatalf("orphan/user rows should not be swallowed:\n%s", out)
	}
	if strings.Count(out, ManagedStartMarker) != 2 {
		t.Fatalf("expected the orphan marker plus one managed block:\n%s", out)
	}
}

func TestApplyManagedPatchPreservesCRLF(t *testing.T) {
	in := "# user note\r\n[]\r\n"
	out, err := ApplyManagedPatch(in, testHooks)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "\n") && !strings.Contains(out, "\r\n") {
		t.Fatalf("CRLF file should stay CRLF:\n%q", out)
	}
	if !strings.Contains(out, "# user note\r\n") {
		t.Fatalf("CRLF user comment lost:\n%q", out)
	}
}
