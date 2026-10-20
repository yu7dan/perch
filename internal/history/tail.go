package history

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
)

// TailHistory 取一个会话最近的对话轮次，给右侧「历史流」用。
// 全部读进来再截尾是浪费 —— 但两个流式读（先定位再回读）在开发阶段
// 不值当，5MB 扫一遍是毫秒级，先这样。
func TailHistory(s Session, stateDir string, keep int) []HistoryItem {
	path := filepath.Join(stateDir, "projects", s.Project, s.ID+".jsonl")
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	items := make([]HistoryItem, 0, keep)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), maxLine)
	for sc.Scan() {
		line := sc.Bytes()
		var role string
		switch {
		case bytes.Contains(line, []byte(`"type":"user"`)):
			role = "user"
		case bytes.Contains(line, []byte(`"type":"assistant"`)):
			role = "assistant"
		default:
			continue
		}
		text := extractText(line)
		if text == "" {
			continue // 纯 tool_use / attachment 轮次，历史流里没有信息量
		}
		items = append(items, HistoryItem{
			Role: role,
			At:   stringField(line, "timestamp"),
			Text: clamp(text, 300),
		})
	}
	if len(items) > keep {
		items = items[len(items)-keep:]
	}
	return items
}
