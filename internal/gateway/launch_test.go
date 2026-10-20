package gateway

import "testing"

func TestParseAgentLaunchAgy(t *testing.T) {
	raw := `$env:GEMINI_API_KEY="tok-123"; $env:GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:3425"; agy --model 'magpie/deepseek/deepseek-flash'`
	env, args, ok := ParseAgentLaunch(raw)
	if !ok {
		t.Fatalf("没认出 magpie 的 agy 启动命令")
	}
	if env["GEMINI_API_KEY"] != "tok-123" {
		t.Fatalf("key = %q", env["GEMINI_API_KEY"])
	}
	if env["GOOGLE_GEMINI_BASE_URL"] != "http://127.0.0.1:3425" {
		t.Fatalf("base = %q", env["GOOGLE_GEMINI_BASE_URL"])
	}
	if len(args) != 2 || args[0] != "--model" || args[1] != "magpie/deepseek/deepseek-flash" {
		t.Fatalf("args = %#v", args)
	}
}

func TestParseAgentLaunchEscapedQuote(t *testing.T) {
	raw := `$env:GEMINI_API_KEY="k"; $env:GOOGLE_GEMINI_BASE_URL="https://gw.example"; agy --model 'magpie/x/it''s'`
	_, args, ok := ParseAgentLaunch(raw)
	if !ok {
		t.Fatal("带转义单引号的命令应被接受")
	}
	if want := "magpie/x/it's"; args[1] != want {
		t.Fatalf("model = %q, want %q", args[1], want)
	}
}

func TestParseAgentLaunchRejectsUnknownShapes(t *testing.T) {
	cases := []string{
		"",
		"agy",
		"$env:GEMINI_API_KEY=\"k\"; agy",
		"$env:GEMINI_API_KEY=\"\"; $env:GOOGLE_GEMINI_BASE_URL=\"http://x\"; agy --model 'm'",
		"$env:GEMINI_API_KEY=\"k\"; $env:GOOGLE_GEMINI_BASE_URL=\"file:///etc\"; agy --model 'm'",
		"$env:GEMINI_API_KEY=\"k\"; $env:GOOGLE_GEMINI_BASE_URL=\"http://x\"; agy --model ''",
		"rm -rf /; agy --model 'm'",
	}
	for _, raw := range cases {
		if _, _, ok := ParseAgentLaunch(raw); ok {
			t.Fatalf("不应接受：%q", raw)
		}
	}
}

func TestStoreLaunchesFromState(t *testing.T) {
	g := New(nil)
	g.storeLaunches([]byte(`{"agents":[
		{"id":"agy","launch":"$env:GEMINI_API_KEY=\"k\"; $env:GOOGLE_GEMINI_BASE_URL=\"http://127.0.0.1:3425\"; agy --model 'magpie/m'"},
		{"id":"claude","launch":""}
	]}`))
	if _, _, ok := g.Launch("agy"); !ok {
		t.Fatal("storeLaunches 没存下 agy 的启动环境")
	}
	if _, _, ok := g.Launch("claude"); ok {
		t.Fatal("空的 launch 不该生效")
	}
	g.storeLaunches([]byte(`not json`))
	if _, _, ok := g.Launch("agy"); !ok {
		t.Fatal("坏 JSON 不应清掉上一份 state")
	}
}

func TestGatewayLaunchUsesLatestState(t *testing.T) {
	g := New(nil)
	g.setAgentLaunch(map[string]string{
		"agy": `$env:GEMINI_API_KEY="k"; $env:GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:3425"; agy --model 'magpie/m'`,
	})
	if _, _, ok := g.Launch("agy"); !ok {
		t.Fatal("应当拿到 agy 的启动环境")
	}
	// 断开接线后整份 state 里不再有 launch：旧值必须失效。
	g.setAgentLaunch(map[string]string{})
	if _, _, ok := g.Launch("agy"); ok {
		t.Fatal("断开后不应继续使用旧的 launch")
	}
}
