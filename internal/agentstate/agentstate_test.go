package agentstate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLaunchPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-state.json")
	s := Open(path)
	s.RecordLaunch("agy", 58, true, "")
	s.RecordReadiness("agy", "ready", "screen")

	again := Open(path)
	got := again.Snapshot()["agy"]
	if got.LastLaunchAt == "" || got.LaunchCount != 1 {
		t.Fatalf("launch 没落盘: %+v", got)
	}
	if got.Steps[StepLaunch].State != StepDone {
		t.Fatalf("launch state = %q", got.Steps[StepLaunch].State)
	}
	if got.Readiness != "ready" || got.Steps[StepAuth].State != StepDone {
		t.Fatalf("readiness 没落盘: %+v", got)
	}
}

func TestLaunchFailureRecordsCode(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "agent-state.json"))
	s.RecordLaunch("cursor", 61, false, "pty")

	got := s.Snapshot()["cursor"]
	st := got.Steps[StepLaunch]
	if st.State != StepFailed || st.ErrorCode != "pty" {
		t.Fatalf("失败没记稳定码: %+v", st)
	}
	if got.LaunchCount != 1 || got.LastLaunchAt == "" {
		t.Fatalf("失败也要算一次打开: %+v", got)
	}
}

func TestReadinessNeedsLoginIsTodo(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "agent-state.json"))
	s.RecordReadiness("cursor", "needs-login", "whoami")

	got := s.Snapshot()["cursor"]
	if got.Readiness != "needs-login" || got.ReadinessSource != "whoami" {
		t.Fatalf("readiness = %+v", got)
	}
	if got.Steps[StepAuth].State != StepTodo {
		t.Fatalf("需要登录应是 todo: %+v", got.Steps[StepAuth])
	}
}

func TestBadJSONIsRenamedAndStoreStartsFresh(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := Open(path)
	s.RecordLaunch("dsh", 1, true, "")

	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var bad bool
	for _, e := range ents {
		if strings.Contains(e.Name(), ".bad-") {
			bad = true
		}
	}
	if !bad {
		t.Fatalf("坏文件没有改名: %v", ents)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("新记录没写出来: %v", err)
	}
}

func TestFutureVersionIsReadOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-state.json")
	orig := []byte(`{"version":99,"agents":{"agy":{"readiness":"ready"}}}`)
	if err := os.WriteFile(path, orig, 0o600); err != nil {
		t.Fatal(err)
	}
	s := Open(path)
	s.RecordLaunch("agy", 1, true, "")

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != string(orig) {
		t.Fatalf("未来版本被覆盖了:\n%s", b)
	}
	if s.Snapshot()["agy"].Readiness != "ready" {
		t.Fatalf("未来版本应能读: %+v", s.Snapshot())
	}
}

func TestSnapshotIsCopy(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "agent-state.json"))
	s.SetStep("agy", StepStatus, Step{State: StepDone, Mechanism: "title"})

	snap := s.Snapshot()
	snap["agy"].Steps[StepStatus] = Step{State: StepFailed}
	if got := s.Snapshot()["agy"].Steps[StepStatus].State; got != StepDone {
		t.Fatalf("外部改了内部: %q", got)
	}
}

func TestSetStepRejectsUnknown(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "agent-state.json"))
	s.SetStep("agy", "nope", Step{State: StepDone})
	if _, ok := s.Snapshot()["agy"]; ok {
		t.Fatal("未知步骤不应创建记录")
	}
}

func TestOnChangeGetsSnapshotOutsideLock(t *testing.T) {
	s := Open(filepath.Join(t.TempDir(), "agent-state.json"))
	var seen map[string]Record
	s.SetOnChange(func(m map[string]Record) { seen = m })
	s.RecordLaunch("pi", 2, true, "")
	if seen["pi"].Steps[StepLaunch].State != StepDone {
		t.Fatalf("回调没拿到快照: %+v", seen)
	}
	// 回调里改快照不能回头改 store。
	seen["pi"].Steps[StepLaunch] = Step{State: StepFailed}
	if got := s.Snapshot()["pi"].Steps[StepLaunch].State; got != StepDone {
		t.Fatalf("回调快照不是拷贝: %q", got)
	}
}

func TestFileShapeIsVersioned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-state.json")
	s := Open(path)
	s.RecordLaunch("codex", 3, true, "")

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var d struct {
		Version int                        `json:"version"`
		Agents  map[string]json.RawMessage `json:"agents"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		t.Fatal(err)
	}
	if d.Version != Version {
		t.Fatalf("version = %d", d.Version)
	}
	if len(d.Agents) != 1 {
		t.Fatalf("agents = %v", d.Agents)
	}
}
