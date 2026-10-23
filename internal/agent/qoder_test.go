package agent

import (
	"os"
	"strings"
	"testing"
)

func TestQoderDefInjectsPerPaneHookSettings(t *testing.T) {
	SetHost(agyTestHost{hookSettings: `{"hooks":{"Stop":[]}}`})
	defer SetHost(defaultHost{})

	env, args, obs, err := QoderDef().Prepare("t9", 9, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if obs != nil {
		t.Fatalf("hooks 注入成功时不该再跑转录状态（会双发）: %v", obs != nil)
	}
	if len(args) != 2 || args[0] != "--settings" {
		t.Fatalf("args = %#v，想要 --settings <path>", args)
	}
	b, err := os.ReadFile(args[1])
	if err != nil || !strings.Contains(string(b), `"hooks"`) {
		t.Fatalf("--settings 文件不是 hooks JSON: %v %q", err, string(b))
	}
	if env["PATH"] == "" {
		t.Fatalf("PATH 必须补齐（GUI 进程的 PATH 比终端短）: %#v", env)
	}
	_ = os.Remove(args[1])
}

func TestQoderDefFallsBackToTranscriptStatus(t *testing.T) {
	SetHost(agyTestHost{}) // HookSettings 返回空 = 接收器不在/造不出来
	defer SetHost(defaultHost{})

	_, args, obs, err := QoderDef().Prepare("t9", 9, `C:\work`, nil)
	if err != nil {
		t.Fatal(err)
	}
	if args != nil || obs == nil {
		t.Fatalf("hooks 失败时应退回转录状态：args=%#v observe=%v", args, obs != nil)
	}
}

func TestQoderResumeArgs(t *testing.T) {
	d := QoderDef()
	cases := []struct {
		in   ResumeIntent
		want []string
	}{
		{ResumeIntent{Kind: "latest"}, []string{"--continue"}},
		{ResumeIntent{Kind: "exact", ID: "abc"}, []string{"--resume", "abc"}},
		{ResumeIntent{Kind: "fork", ID: "abc"}, []string{"--resume", "abc", "--fork-session"}},
		{ResumeIntent{Kind: "new"}, nil},
	}
	for _, c := range cases {
		got := d.Args(c.in, "")
		if strings.Join(got, " ") != strings.Join(c.want, " ") {
			t.Fatalf("%+v → %#v，想要 %#v", c.in, got, c.want)
		}
	}
}
