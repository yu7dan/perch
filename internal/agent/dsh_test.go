package agent

import "testing"

type dshTestHost struct {
	env  map[string]string
	args []string
	ok   bool
}

func (h dshTestHost) BindSession(int, string, string, string) bool { return false }
func (h dshTestHost) RebindSession(int, string, string, string) bool {
	return false
}
func (h dshTestHost) SetStatus(int, string) (string, bool) { return "", false }
func (h dshTestHost) Push(any)                             {}
func (h dshTestHost) ResolveExe(bin string) (string, []string) {
	return bin, nil
}
func (h dshTestHost) WireLaunch(id string) (map[string]string, []string, bool) {
	if id != "dsh" {
		return nil, nil, false
	}
	return h.env, h.args, h.ok
}

func TestDshDefDefaultsToWebProfile(t *testing.T) {
	SetHost(dshTestHost{})
	defer SetHost(defaultHost{})

	d := DshDef()
	env, args, obs, err := d.Prepare("tag", 1, `C:\work`)
	if err != nil {
		t.Fatal(err)
	}
	if env != nil || obs != nil {
		t.Fatalf("默认启动不应注入 env/observe：env=%#v observe_nil=%v", env, obs == nil)
	}
	want := []string{"--profile", "web"}
	if len(args) != len(want) {
		t.Fatalf("args = %#v", args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args = %#v，want %#v", args, want)
		}
	}
}

func TestDshDefUsesWireLaunchWhenPresent(t *testing.T) {
	SetHost(dshTestHost{
		env:  map[string]string{"DSH_TOKEN": "t"},
		args: []string{"--profile", "custom"},
		ok:   true,
	})
	defer SetHost(defaultHost{})

	d := DshDef()
	env, args, _, err := d.Prepare("tag", 1, `C:\work`)
	if err != nil {
		t.Fatal(err)
	}
	if env["DSH_TOKEN"] != "t" {
		t.Fatalf("env = %#v", env)
	}
	if len(args) != 2 || args[0] != "--profile" || args[1] != "custom" {
		t.Fatalf("args = %#v", args)
	}
}
