package term

import (
	"strings"
	"testing"
)

// 主题跟着前端的有效明暗走：OSC 11 应答和 COLORFGBG 必须是同一边。
func TestOSCReplyFollowsTheme(t *testing.T) {
	defer SetLight(false)
	for _, tc := range []struct {
		light bool
		bg    string
		fgbg  string
		reply string
	}{
		{false, darkBackground, "15;0", "rgb:0a0a/0a0a/0a0a"},
		{true, lightBackground, "0;15", "rgb:fbfb/fbfb/fcfc"},
	} {
		SetLight(tc.light)
		if _, bg := Colors(); bg != tc.bg {
			t.Errorf("light=%v: bg %s, want %s", tc.light, bg, tc.bg)
		}
		if got := ColorFGBG(); got != tc.fgbg {
			t.Errorf("light=%v: COLORFGBG %s, want %s", tc.light, got, tc.fgbg)
		}
		replies := NewOSCResponder().Scan([]byte("\x1b]11;?\x07"))
		if len(replies) != 1 || !strings.Contains(replies[0], tc.reply) {
			t.Errorf("light=%v: OSC 11 reply %q, want it to contain %s", tc.light, replies, tc.reply)
		}
	}
}
