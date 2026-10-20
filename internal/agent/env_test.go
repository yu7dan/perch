package agent

import (
	"strings"
	"testing"
)

func TestBuildEnvExtraOverridesPathCaseInsensitively(t *testing.T) {
	t.Setenv("PATH", `C:\old-path`)
	env := BuildEnv(map[string]string{"PATH": `C:\new-path`})

	count := 0
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		if strings.EqualFold(k, "PATH") {
			count++
			if v != `C:\new-path` {
				t.Fatalf("PATH = %q, want the extra value", v)
			}
		}
	}
	if count != 1 {
		t.Fatalf("found %d PATH entries, want exactly 1", count)
	}
}

func TestBuildEnvStillBlocksHostTerminalIdentity(t *testing.T) {
	t.Setenv("TERM_PROGRAM", "WindowsTerminal")
	t.Setenv("NO_COLOR", "1")
	env := BuildEnv(nil)
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		switch strings.ToUpper(k) {
		case "TERM_PROGRAM":
			// BuildEnv 自己会重新声明 TERM_PROGRAM=perch；宿主的那个不能留下。
			if v != "perch" {
				t.Fatalf("TERM_PROGRAM = %q, want perch", v)
			}
		case "NO_COLOR":
			t.Fatalf("NO_COLOR leaked from host: %q", v)
		}
	}
}
