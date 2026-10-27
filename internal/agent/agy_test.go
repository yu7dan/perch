package agent

import "testing"

type agyTestHost struct {
	hookSettings string
}

func (h agyTestHost) BindSession(int, string, string, string) bool { return false }
func (h agyTestHost) RebindSession(int, string, string, string) bool {
	return false
}
func (h agyTestHost) SetStatus(int, string) (string, bool) { return "", false }
func (h agyTestHost) Push(any)                             {}
func (h agyTestHost) ResolveExe(bin string) (string, []string) {
	return bin, nil
}
func (h agyTestHost) HookSettings(string) string { return h.hookSettings }
func (h agyTestHost) NoteActivity(int, bool)     {}
func (h agyTestHost) ResumeSessionOf(int) string { return "" }

// agy 的模型提供商 env 由 session.Manager 按格注入；Prepare 自己不加 env/参数，
// 只负责跟转录。
func TestAgyDefPrepareOnlyObserves(t *testing.T) {
	SetHost(agyTestHost{})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env != nil || args != nil || obs == nil {
		t.Fatalf("agy 不应自己注入 env/参数，但要跟转录：env=%#v args=%#v observe=%v", env, args, obs != nil)
	}
}

func TestPathDefOnlyAddsPath(t *testing.T) {
	SetHost(agyTestHost{})
	defer SetHost(defaultHost{})

	d := PathDef("gemini")
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env["PATH"] == "" {
		t.Fatalf("通用 CLI 只补 PATH：%#v", env)
	}
	if args != nil || obs != nil {
		t.Fatalf("unexpected args/observe: args=%#v observe=%v", args, obs != nil)
	}
}
