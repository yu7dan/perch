package botgroup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateDerivedAndStandalone(t *testing.T) {
	dir, proj := t.TempDir(), t.TempDir()
	s := Load(dir)
	g, err := s.Create(CreateInput{Name: "Perch 产品团队", Goal: "beta.5", Project: proj,
		SourcePane: 7, SourceAgent: "claude", SourceTitle: "Perch 主线",
		Bots: []BotInput{{Role: "维护", Agent: "codex"}, {Role: "宣发", Agent: "pi", Task: "changelog"}}})
	if err != nil {
		t.Fatal(err)
	}
	if g.Source.Kind != "derived" || len(g.Bots) != 3 || !g.Bots[0].Manager || g.Bots[0].PaneID != 7 || g.Bots[0].Agent != "claude" {
		t.Fatalf("group = %+v", g)
	}
	if gid, bot, ok := s.GroupOfPane(7); !ok || gid != g.ID || bot != "manager" {
		t.Fatalf("GroupOfPane(7) = %s %s %v", gid, bot, ok)
	}
	if _, err := s.Create(CreateInput{Name: "x", Project: proj, SourcePane: 7, SourceAgent: "claude"}); err == nil {
		t.Fatal("same source pane joined two groups")
	}
	b, err := os.ReadFile(g.Brief)
	if err != nil || !strings.Contains(string(b), "宣发") {
		t.Fatalf("brief = %q %v", b, err)
	}
	if err := s.BindPane(g.ID, "b1", 12); err != nil {
		t.Fatal(err)
	}
	// 重新载入还在
	s2 := Load(dir)
	if gid, bot, ok := s2.GroupOfPane(12); !ok || gid != g.ID || bot != "b1" {
		t.Fatalf("after reload GroupOfPane(12) = %s %s %v", gid, bot, ok)
	}
	if _, err := s.Create(CreateInput{Name: "y", Project: proj}); err == nil {
		t.Fatal("standalone without manager agent accepted")
	}
	g2, err := s.Create(CreateInput{Name: "宣传片", Project: proj, ManagerAgent: "claude", Bots: []BotInput{{Role: "剪辑", Agent: "codex"}}})
	if err != nil || g2.Source.Kind != "standalone" || g2.Bots[0].PaneID != 0 {
		t.Fatalf("standalone = %+v %v", g2, err)
	}
	if _, err := s.Create(CreateInput{Name: "z", Project: filepath.Join(proj, "nope"), ManagerAgent: "claude"}); err == nil {
		t.Fatal("missing project accepted")
	}
}

// 事件 id 在组内单调递增，重启后接着往下数；按 id 续读。
func TestEventsAnchorByID(t *testing.T) {
	dir, proj := t.TempDir(), t.TempDir()
	s := Load(dir)
	g, _ := s.Create(CreateInput{Name: "g", Project: proj, ManagerAgent: "claude"})
	for i := 0; i < 3; i++ {
		if _, err := s.Append(g.ID, Event{Kind: "started", Title: "x"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Append(g.ID, Event{Kind: "bogus", Title: "x"}); err == nil {
		t.Fatal("unknown kind accepted")
	}
	s2 := Load(dir)
	e, err := s2.Append(g.ID, Event{Kind: "idle", Title: "y"})
	if err != nil || e.ID != 4 {
		t.Fatalf("id after reload = %d %v", e.ID, err)
	}
	got := s2.Events(g.ID, 2, 0)
	if len(got) != 2 || got[0].ID != 3 || got[1].ID != 4 {
		t.Fatalf("since 2 = %+v", got)
	}
	if got := s2.Events(g.ID, 0, 1); len(got) != 1 || got[0].ID != 4 {
		t.Fatalf("limit 1 = %+v", got)
	}
	if err := s2.Delete(g.ID); err != nil {
		t.Fatal(err)
	}
	if len(s2.List()) != 0 {
		t.Fatal("group not deleted")
	}
}

func TestUpdateRemoveBot(t *testing.T) {
	dir, proj, other := t.TempDir(), t.TempDir(), t.TempDir()
	s := Load(dir)
	g, _ := s.Create(CreateInput{Name: "g", Project: proj, ManagerAgent: "claude", Bots: []BotInput{{Role: "开发", Agent: "codex"}}})
	str := func(v string) *string { return &v }
	if err := s.BindPane(g.ID, "b1", 7); err != nil {
		t.Fatal(err)
	}
	b, err := s.UpdateBot(g.ID, "b1", BotPatch{Role: str(" 维护 "), Model: str("gpt-5"), Permission: str("workspace-write"), Folder: str(other)})
	if err != nil || b.Role != "维护" || b.Model != "gpt-5" || b.Permission != "workspace-write" || b.Folder != other || b.PaneID != 7 {
		t.Fatalf("UpdateBot = %+v %v", b, err)
	}
	if _, err := s.UpdateBot(g.ID, "b1", BotPatch{Permission: str("root")}); err == nil {
		t.Fatal("bad permission accepted")
	}
	if _, err := s.UpdateBot(g.ID, "b1", BotPatch{Folder: str(filepath.Join(other, "nope"))}); err == nil {
		t.Fatal("missing folder accepted")
	}
	// 文件夹改回项目目录 = 清空（跟随组）；换 agent 清掉格子和模型。
	b, _ = s.UpdateBot(g.ID, "b1", BotPatch{Folder: str(proj), Agent: str("claude")})
	if b.Folder != "" || b.PaneID != 0 || b.Model != "" || b.Agent != "claude" {
		t.Fatalf("after agent switch = %+v", b)
	}
	if _, err := s.UpdateBot(g.ID, "manager", BotPatch{Role: str("x")}); err == nil {
		t.Fatal("manager rename accepted")
	}
	if _, err := s.RemoveBot(g.ID, "manager"); err == nil {
		t.Fatal("manager removed")
	}
	if _, err := s.RemoveBot(g.ID, "b1"); err != nil {
		t.Fatal(err)
	}
	if got := len(Load(dir).List()[0].Bots); got != 1 {
		t.Fatalf("after remove bots=%d", got)
	}
}

func TestAddBot(t *testing.T) {
	dir, proj := t.TempDir(), t.TempDir()
	s := Load(dir)
	g, _ := s.Create(CreateInput{Name: "g", Project: proj, ManagerAgent: "claude", Bots: []BotInput{{Role: "开发", Agent: "codex"}}})
	b, err := s.AddBot(g.ID, BotInput{Role: "审阅", Agent: "opencode"})
	if err != nil || b.ID != "b2" {
		t.Fatalf("AddBot = %+v %v", b, err)
	}
	if _, err := s.AddBot(g.ID, BotInput{Role: "", Agent: "x"}); err == nil {
		t.Fatal("empty role accepted")
	}
	for i := 0; i < MaxBots-2; i++ {
		if _, err := s.AddBot(g.ID, BotInput{Role: "r", Agent: "codex"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddBot(g.ID, BotInput{Role: "over", Agent: "codex"}); err == nil {
		t.Fatal("more than MaxBots accepted")
	}
	if got := len(Load(dir).List()[0].Bots); got != MaxBots+1 {
		t.Fatalf("after reload bots=%d", got)
	}
}
