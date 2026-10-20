package gateway

// 界面语言同步。
//
// magpie 自己就有一套语言设置（settings.Lang：system / en / zh / zh-TW / ja / de，
// GET/POST /api/settings，页面收到 state 里的 settings.lang 会就地 setLocale）。
// Perch 不另造一份：设置页的语言选择是**唯一的那一份用户输入**，这里只把它
// 翻译成 magpie 的取值并写过去。
//
// 为什么必须走 API 而不是改 magpie 的 settings.json：那个文件归 magpie 所有，
// 它可能正在运行，而且格式/归属规则不该由 Perch 猜。
//
// 同步是尽力而为：失败只落日志，不把网关页换成红字 —— 语言不该拦住用户用网关。

import (
	"encoding/json"
	"log"
	"strings"
)

// SetLanguage 接收 Perch 自己的语言偏好（auto / en / zh），记下来并尝试
// 立刻同步到已连接的控制面。没连接时只记着，等 Ensure 成功后再写。
func (g *Gateway) SetLanguage(pref string) {
	want := magpieLang(pref)
	g.langMu.Lock()
	changed := g.langWant != want
	g.langWant = want
	g.langMu.Unlock()
	if changed {
		go g.applyLanguage()
	}
}

// magpieLang 把 Perch 的 auto/en/zh 映射到 magpie 的取值。
// auto = 跟随系统，和 Perch 前端的 auto 同一层含义。
func magpieLang(pref string) string {
	switch strings.ToLower(strings.TrimSpace(pref)) {
	case "en":
		return "en"
	case "zh":
		return "zh"
	default:
		return "system"
	}
}

// applyLanguage 读一次 magpie 的整份设置，只改 lang，再整份写回。
//
// 为什么整份回写而不是 {"lang":"zh"}：magpie 的 POST /api/settings 是按
// "页面提交了它的全部选择"设计的，只发一个字段会让它把没发的字段当成零值
// （主题、货币等会被一起重置）。GET 出来的这份本来就是当前的权威值，原样
// 带回只换 lang 是安全的；密钥字段 magpie 在 GET 时就留空、POST 时会从
// 当前设置里补回，所以也不会把凭据覆盖掉。
func (g *Gateway) applyLanguage() {
	if !g.langRun.TryLock() {
		return
	}
	defer g.langRun.Unlock()

	for {
		g.langMu.Lock()
		want, applied := g.langWant, g.langApplied
		g.langMu.Unlock()
		if want == "" || want == applied {
			return
		}
		if _, _, client, _ := g.connState(); client == nil {
			return
		}

		b, err := g.API("GET", "/api/settings", nil)
		if err != nil {
			log.Printf("[gw] 同步界面语言失败（读设置）：%v", err)
			return
		}
		var doc map[string]json.RawMessage
		if err := json.Unmarshal(b, &doc); err != nil {
			log.Printf("[gw] 同步界面语言失败（设置不是对象）：%v", err)
			return
		}
		var cur string
		if raw, ok := doc["lang"]; ok {
			_ = json.Unmarshal(raw, &cur)
		}
		if cur == want {
			g.markLangApplied(want)
			return
		}
		lang, err := json.Marshal(want)
		if err != nil {
			return
		}
		doc["lang"] = lang
		if _, err := g.API("POST", "/api/settings", doc); err != nil {
			log.Printf("[gw] 同步界面语言失败（写设置）：%v", err)
			return
		}
		g.markLangApplied(want)
		log.Printf("[gw] magpie 界面语言已同步为 %s", want)
		// 内嵌页已经加载过的话，它自己的 state 轮询不一定会在隐藏时跑；
		// 告诉前端"可以重载了"——重载后 boot.js 就会读到刚写进去的 lang。
		g.emit(map[string]any{"type": "gw.lang", "lang": want, "at": nowISO()})

		// 写入期间用户又换了语言：接着把最新那份写上。
		g.langMu.Lock()
		next := g.langWant
		g.langMu.Unlock()
		if next == want {
			return
		}
	}
}

func (g *Gateway) markLangApplied(lang string) {
	g.langMu.Lock()
	g.langApplied = lang
	g.langMu.Unlock()
}
