// Package workspacebrief owns the shared brief that every agent in a project
// can read. It deliberately writes two places:
//
//   - <project>/.perch/workspace.md — Perch's canonical copy, the thing the
//     editor reads and writes;
//   - <project>/AGENTS.md — a marked section. Eight of the nine agents read
//     AGENTS.md natively; Claude gets a short --append-system-prompt pointing
//     at the canonical file (see session.StartTab).
//
// The marked section never overwrites the user's own AGENTS.md content. It is
// replaced or removed as a block, and an incomplete marker pair is an error
// rather than something we silently mangle.
package workspacebrief

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	DirName    = ".perch"
	FileName   = "workspace.md"
	AgentsName = "AGENTS.md"
	// MaxBytes is the same order as Codex's AGENTS.md cap. A brief is context,
	// not a document store; a 64 KiB cap keeps it out of command-line limits
	// and makes a typo in a paste fail loudly.
	MaxBytes = 64 << 10

	startMarker = "<!-- perch:workspace-brief:start -->"
	endMarker   = "<!-- perch:workspace-brief:end -->"
)

// ErrMalformedAgents means AGENTS.md contains only one half of our marker pair.
// We refuse to guess which side of the user's content belongs to the section.
var ErrMalformedAgents = errors.New("AGENTS.md has an incomplete Perch workspace brief section")

// ErrTooLarge is returned when the canonical content exceeds MaxBytes.
var ErrTooLarge = fmt.Errorf("workspace brief is larger than %d bytes", MaxBytes)

// Path returns the canonical brief path for a project root.
func Path(root string) string {
	return filepath.Join(root, DirName, FileName)
}

// AgentsPath returns the AGENTS.md path for a project root.
func AgentsPath(root string) string {
	return filepath.Join(root, AgentsName)
}

// Read returns the canonical brief. ok is false when the file does not exist;
// an empty file is still ok=true with an empty string.
func Read(root string) (content string, ok bool, err error) {
	b, err := os.ReadFile(Path(root))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(b), true, nil
}

// Find walks up from cwd and returns the first canonical brief it finds.
// It is used at agent launch time, where cwd may be a subdirectory of the
// project root.
func Find(cwd string) (path string, ok bool) {
	p, err := filepath.Abs(strings.TrimSpace(cwd))
	if err != nil || p == "" {
		return "", false
	}
	for {
		candidate := Path(p)
		if fi, err := os.Stat(candidate); err == nil && !fi.IsDir() {
			return candidate, true
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", false
		}
		p = parent
	}
}

// ClaudePrompt is intentionally short. The full brief stays on disk; Claude
// reads it with its normal file tools. This avoids Windows' command-line
// length limit and keeps the prompt stable when the brief grows.
func ClaudePrompt(path string) string {
	return "Perch workspace brief: read the shared brief at " + path +
		" before starting. It is shared by every agent in this project; do not edit it unless the user asks."
}

// Result describes a successful read/write.
type Result struct {
	Path       string
	AgentsPath string
	Content    string
	Existed    bool
}

// Set writes the canonical brief and updates the marked AGENTS.md section.
// It validates both files before writing anything, so a malformed marker pair
// cannot leave the canonical copy updated while AGENTS.md is untouched.
func Set(root, content string) (Result, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "" || root == "." {
		return Result{}, errors.New("empty project root")
	}
	if fi, err := os.Stat(root); err != nil {
		return Result{}, err
	} else if !fi.IsDir() {
		return Result{}, fmt.Errorf("project root is not a directory: %s", root)
	}
	if len([]byte(content)) > MaxBytes {
		return Result{}, ErrTooLarge
	}
	if err := ensureNotSymlink(Path(root)); err != nil {
		return Result{}, err
	}
	if err := ensureNotSymlink(filepath.Join(root, DirName)); err != nil {
		return Result{}, err
	}
	if err := ensureNotSymlink(AgentsPath(root)); err != nil {
		return Result{}, err
	}

	agentsBefore, err := os.ReadFile(AgentsPath(root))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Result{}, err
	}
	agentsAfter, changed, err := upsertSection(agentsBefore, content)
	if err != nil {
		return Result{}, err
	}

	if err := writeAtomic(Path(root), []byte(content)); err != nil {
		return Result{}, err
	}
	if changed {
		if err := writeAtomic(AgentsPath(root), agentsAfter); err != nil {
			return Result{}, err
		}
	}
	return Result{
		Path:       Path(root),
		AgentsPath: AgentsPath(root),
		Content:    content,
		Existed:    true,
	}, nil
}

// ensureNotSymlink refuses to write through a symlink. The brief lives inside
// a user-selected folder; following a planted link would turn "edit a brief"
// into an arbitrary-file write outside the project.
func ensureNotSymlink(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("refusing to write through a symlink: %s", path)
	}
	return nil
}

// Section renders the marked block, without relying on the surrounding file's
// newline style. The content is kept verbatim.
func Section(content string) string {
	return startMarker + "\n## Perch workspace brief\n\n" + content + "\n" + endMarker
}

// upsertSection replaces the marked block, appends one when content is
// non-empty, or removes it when content is empty. Everything outside the
// markers is preserved byte-for-byte.
func upsertSection(existing []byte, content string) ([]byte, bool, error) {
	s := string(existing)
	start := strings.Index(s, startMarker)
	end := strings.Index(s, endMarker)
	if (start >= 0) != (end >= 0) {
		return nil, false, ErrMalformedAgents
	}
	hasSection := start >= 0
	if hasSection && end < start {
		return nil, false, ErrMalformedAgents
	}

	empty := strings.TrimSpace(content) == ""
	if !hasSection {
		if empty {
			return existing, false, nil
		}
		block := Section(content)
		if s != "" && !strings.HasSuffix(s, "\n") {
			s += "\n"
		}
		if s != "" {
			s += "\n"
		}
		s += block
		if !strings.HasSuffix(s, "\n") {
			s += "\n"
		}
		return []byte(s), true, nil
	}

	before := s[:start]
	after := s[end+len(endMarker):]
	if empty {
		// Drop the block and the blank line immediately before it, but keep
		// the user's own content (including any heading above it).
		before = strings.TrimRight(before, "\r\n")
		after = strings.TrimLeft(after, "\r\n")
		if before != "" && after != "" {
			before += "\n\n"
		} else if before != "" {
			before += "\n"
		}
		return []byte(before + after), true, nil
	}
	block := Section(content)
	// Keep the original spacing around the block; only the block itself changes.
	if before != "" && !strings.HasSuffix(before, "\n") {
		before += "\n"
	}
	if after != "" && !strings.HasPrefix(after, "\n") {
		after = "\n" + after
	}
	return []byte(before + block + after), true, nil
}

func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := ensureNotSymlink(path); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	// Windows' os.Rename does not replace an existing file. Removing first is
	// the smallest portable implementation; the temp file still protects
	// against a partial write.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// HasVisibleContent reports whether a brief should be injected into a prompt.
func HasVisibleContent(content string) bool {
	return len(bytes.TrimSpace([]byte(content))) > 0
}
