package ctl

// 协议形状与关窗确认的特征测试。ctl 的字段名/JSON tag 是前后端契约的一部分
// （结构整理不许改）；这里的断言只锁"已经跑通的形状"，不锁实现。

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMsgWireShape(t *testing.T) {
	raw := `{
		"type": "settings.set",
		"req": 7,
		"msg": "hi",
		"on": true,
		"why": "unread",
		"tab": 3,
		"pane": 9,
		"mode": "reveal",
		"path": "C:\\tmp\\x",
		"root": "C:\\tmp",
		"name": "n",
		"source": "manual",
		"id": "abc",
		"url": "https://example.com",
		"field": "model",
		"value": "",
		"settings": {
			"defaultCwd": "C:\\work",
			"termFontSize": 14,
			"confirmClose": false
		}
	}`
	var m Msg
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Type != "settings.set" || m.Req != 7 || m.Tab != 3 || m.Pane != 9 {
		t.Fatalf("scalar fields lost: %+v", m)
	}
	if !m.On || m.Why != "unread" {
		t.Fatalf("attention fields lost: %+v", m)
	}
	if m.ID != "abc" || m.Root != "C:\\tmp" || m.Source != "manual" {
		t.Fatalf("identity fields lost: %+v", m)
	}
	if m.Settings == nil {
		t.Fatal("settings pointer is nil")
	}
	if m.Settings.DefaultCWD == nil || *m.Settings.DefaultCWD != `C:\work` {
		t.Fatalf("defaultCwd lost: %+v", m.Settings.DefaultCWD)
	}
	// false 是合法值，不能被 omitempty/零值判断吃掉。
	if m.Settings.ConfirmClose == nil || *m.Settings.ConfirmClose {
		t.Fatalf("confirmClose=false lost: %+v", m.Settings.ConfirmClose)
	}
	if m.Settings.TermFontSize == nil || *m.Settings.TermFontSize != 14 {
		t.Fatalf("font size lost: %+v", m.Settings.TermFontSize)
	}

	// Value 不套 omitempty：空串是"还原成 agent 默认"的有效指令。
	b, err := json.Marshal(Msg{Type: "gw.agent.set", Field: "model", Value: ""})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal map: %v", err)
	}
	if v, ok := out["value"]; !ok || v != "" {
		t.Fatalf("empty value must stay on the wire, got %v (present=%v): %s", v, ok, b)
	}
	if _, ok := out["field"]; !ok {
		t.Fatalf("field missing: %s", b)
	}
}

func TestMsgSpawnSpecShape(t *testing.T) {
	raw := `{"type":"tab.new","req":2,"spec":{"agent":"claude","cwd":"C:\\w","resume":{"kind":"exact","id":"sid-1"},"paneId":5,"degradedFrom":"old"}}`
	var m Msg
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Spec == nil {
		t.Fatal("spec is nil")
	}
	if m.Spec.Agent != "claude" || m.Spec.CWD != `C:\w` || m.Spec.PaneID != 5 {
		t.Fatalf("spec fields lost: %+v", *m.Spec)
	}
	if m.Spec.Resume.Kind != "exact" || m.Spec.Resume.ID != "sid-1" {
		t.Fatalf("resume intent lost: %+v", m.Spec.Resume)
	}
	if m.Spec.DegradedFrom != "old" {
		t.Fatalf("degradedFrom lost: %+v", m.Spec)
	}
}

func TestMsgProviderAndUsageFields(t *testing.T) {
	raw := `{"type":"gw.provider.save","preset":"kimi","period":"7d","endpoints":{"chat":"https://api.example/v1"}}`
	var m Msg
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m.Preset != "kimi" || m.Period != "7d" || m.Endpoints["chat"] != "https://api.example/v1" {
		t.Fatalf("new fields lost: %+v", m)
	}

	b, err := json.Marshal(Msg{Type: "gw.usage", Period: "30d"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"period":"30d"`) {
		t.Fatalf("period missing: %s", b)
	}
}

func TestCloseGuard(t *testing.T) {
	var g CloseGuard

	// 关窗确认关着：放行。
	if cancel, emit := g.ShouldAsk(false, true); cancel || emit {
		t.Fatalf("disabled guard should pass through, got cancel=%v emit=%v", cancel, emit)
	}
	// 前端不在：放行（不能把窗口锁死）。
	if cancel, emit := g.ShouldAsk(true, false); cancel || emit {
		t.Fatalf("disconnected guard should pass through, got cancel=%v emit=%v", cancel, emit)
	}
	// 开着且连着：拦下来并问。
	if cancel, emit := g.ShouldAsk(true, true); !cancel || !emit {
		t.Fatalf("enabled guard should ask, got cancel=%v emit=%v", cancel, emit)
	}
	// 30s 内重复关窗：仍然拦（原语义是每次都 Cancel，只是不重复记日志）。
	if cancel, emit := g.ShouldAsk(true, true); !cancel || !emit {
		t.Fatalf("second ask within timeout should still ask, got cancel=%v emit=%v", cancel, emit)
	}
	// 取消后仍会再问。
	g.Cancel()
	if cancel, emit := g.ShouldAsk(true, true); !cancel || !emit {
		t.Fatalf("after cancel should ask again, got cancel=%v emit=%v", cancel, emit)
	}
	// 确认后放行。
	g.Confirm()
	if cancel, emit := g.ShouldAsk(true, true); cancel || emit {
		t.Fatalf("confirmed guard should pass, got cancel=%v emit=%v", cancel, emit)
	}
}
