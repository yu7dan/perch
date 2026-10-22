package agent

import "testing"

type agyTestHost struct {
	env  map[string]string
	args []string
	ok   bool
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

func TestAgyDefInjectsWireLaunch(t *testing.T) {
	SetHost(agyTestHost{
		env:  map[string]string{"GEMINI_API_KEY": "k", "GOOGLE_GEMINI_BASE_URL": "http://127.0.0.1:3425"},
		args: []string{"--model", "magpie/m"},
		ok:   true,
	})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, args, _, err := d.Prepare("tag", 1, `C:\work`)
	if err != nil {
		t.Fatal(err)
	}
	if env["GEMINI_API_KEY"] != "k" || env["GOOGLE_GEMINI_BASE_URL"] != "http://127.0.0.1:3425" {
		t.Fatalf("env = %#v", env)
	}
	if env["PERCH_AGENT_PANE"] != "tag" {
		t.Fatalf("格子身份没注入：%#v", env)
	}
	if len(args) != 2 || args[0] != "--model" || args[1] != "magpie/m" {
		t.Fatalf("args = %#v", args)
	}
}

func TestAgyDefFallsBackWhenUnwired(t *testing.T) {
	SetHost(agyTestHost{})
	defer SetHost(defaultHost{})

	d := AgyDef()
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`)
	if err != nil {
		t.Fatal(err)
	}
	if len(env) != 1 || env["PERCH_AGENT_PANE"] != "tag" || args != nil || obs != nil {
		t.Fatalf("未接线时只应注入格子身份：env=%#v args=%#v", env, args)
	}
}
