package agent

import "testing"

type agyTestHost struct {
	env     map[string]string
	args    []string
	ok      bool
	homeEnv map[string]string
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
func (h agyTestHost) WireLaunch(id string) (map[string]string, []string, bool) {
	if id != "agy" {
		return nil, nil, false
	}
	return h.env, h.args, h.ok
}
func (h agyTestHost) EngineHomeEnv() map[string]string          { return h.homeEnv }
func (h agyTestHost) EngineHomeEnvFor(string) map[string]string { return h.homeEnv }

func TestAgyDefInjectsWireLaunch(t *testing.T) {
	SetHost(agyTestHost{
		env:  map[string]string{"GEMINI_API_KEY": "k", "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:3425"},
		args: []string{"--model", "magpie/m"},
		ok:   true,
	})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, args, _, err := d.Prepare("tag", 1, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env["GEMINI_API_KEY"] != "k" || env["GOOGLE_GEMINI_BASE_URL"] != "http://127.0.0.1:3425" {
		t.Fatalf("env = %#v", env)
	}
	if len(args) != 2 || args[0] != "--model" || args[1] != "magpie/m" {
		t.Fatalf("args = %#v", args)
	}
}

func TestAgyDefUsesEngineHomeEnv(t *testing.T) {
	SetHost(agyTestHost{
		env:     map[string]string{"GEMINI_API_KEY": "k"},
		ok:      true,
		homeEnv: map[string]string{"USERPROFILE": `C:\sandbox`, "HOME": `C:\sandbox`},
	})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, _, _, err := d.Prepare("tag", 1, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env["USERPROFILE"] != `C:\sandbox` || env["HOME"] != `C:\sandbox` {
		t.Fatalf("engine home env not applied: %#v", env)
	}
	if env["GEMINI_API_KEY"] != "k" {
		t.Fatalf("wire env lost: %#v", env)
	}
}

func TestEngineDefUsesEngineHomeEnv(t *testing.T) {
	SetHost(agyTestHost{
		homeEnv: map[string]string{"USERPROFILE": `C:\sandbox`, "HOME": `C:\sandbox`},
	})
	defer SetHost(defaultHost{})

	d := EngineDef("gemini", "gemini")
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env["USERPROFILE"] != `C:\sandbox` || env["HOME"] != `C:\sandbox` {
		t.Fatalf("engine home env not applied: %#v", env)
	}
	if args != nil || obs != nil {
		t.Fatalf("unexpected args/observe: args=%#v observe=%v", args, obs != nil)
	}
}

func TestAgyDefFallsBackWhenUnwired(t *testing.T) {
	SetHost(agyTestHost{})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if env != nil || args != nil || obs != nil {
		t.Fatalf("未接线时不应注入：env=%#v args=%#v", env, args)
	}
}
