package install

import (
	"strings"
	"testing"

	"github.com/yu7dan/perch/internal/agentcatalog"
)

func TestPiRecipeChecksNodeVersion(t *testing.T) {
	s := recipeScript(agentcatalog.Recipes["pi"])
	for _, want := range []string{"$needNode", "22.19.0", "winget install", "Node.js 版本仍低于"} {
		if !strings.Contains(s, want) {
			t.Errorf("Pi recipe missing %q:\n%s", want, s)
		}
	}
}

func TestPathPreludeKeepsCurrentPath(t *testing.T) {
	if !strings.Contains(pathPrelude, "$env:Path") || !strings.Contains(pathPrelude, "+ $env:Path") {
		t.Fatalf("pathPrelude dropped the launching process' PATH:\n%s", pathPrelude)
	}
}
