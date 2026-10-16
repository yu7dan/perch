package main

import "testing"

// systemTurn 是**按形状**认的，形状又来自实测 —— 那就把它按实测原文钉死。
// 下面每一条都是从一个真实转录里抄下来的（出处写在名字里），不是编的样例：
// 编出来的样例只会证明"我写的判据和我想的一样"，证明不了它认识现实。
func TestSystemTurn(t *testing.T) {
	cases := []struct {
		name  string
		txt   string
		label string
		drop  bool
	}{
		{
			// 2026-10-15 18:49:49 实测（会话 cced8829，SubagentStop agent_id=a3e601df）。
			// 它曾经整段落成 prompt —— 就是这条促成了白话前缀规则。
			name: "子代理交回报告",
			txt: "Another Claude session sent a message:\n" +
				`<agent-message from="a3e601dfd9259f93a">` + "\n" +
				"[Subagent hand-back] The text below is the final report of a subagent",
			label: "子代理回报",
		},
		{
			// 同一层包装、但框里不是 hand-back ⇒ 退回宽的说法。
			// 认错"是谁"可以容忍，认成"你在说话"不可以。
			name: "跨会话消息（无 hand-back 标记）",
			txt: "Another Claude session sent a message:\n" +
				`<agent-message from="deadbeef">` + "\nhello from the other session",
			label: "跨会话消息",
		},
		{
			name:  "system-reminder 丢掉",
			txt:   "<system-reminder>\nToday's date is 2026-10-15.\n</system-reminder>",
			drop:  true,
			label: "",
		},
		{
			name:  "命令回显丢掉",
			txt:   "<command-name>/model</command-name>\n<command-message>model</command-message>",
			drop:  true,
			label: "",
		},
		{
			name:  "cross-session 标签",
			txt:   `<cross-session-message from="main">ping</cross-session-message>`,
			label: "跨会话消息",
		},
		{
			name:  "task-notification 标签",
			txt:   "<task-notification>\nbackground task finished\n</task-notification>",
			label: "任务通知",
		},
		{
			name:  "不认识的白话 = 用户的话（漏认的代价只是标签不对，不是丢）",
			txt:   "帮我看看这个文件",
			label: "",
		},
		{
			// 判据是"以 < 开头且像标签"：<b> 这种太短的正文不算标签。
			name:  "短标签不算系统条目",
			txt:   "<b>加粗</b>",
			label: "",
		},
		{
			// 手打一段 XML 会被归成系统条目 —— 这是**已知代价**，写在这里
			// 免得以后有人当成 bug 去"修"（正文照样在，只是标签换了个说法）。
			name:  "用户手打的 XML 标签会被认成系统条目（已知代价）",
			txt:   `<mytag some="attr">正文</mytag>`,
			label: "mytag",
		},
	}
	for _, c := range cases {
		label, drop := systemTurn(c.txt)
		if label != c.label || drop != c.drop {
			t.Errorf("%s: systemTurn() = (%q, %v), 想要 (%q, %v)", c.name, label, drop, c.label, c.drop)
		}
	}
}
