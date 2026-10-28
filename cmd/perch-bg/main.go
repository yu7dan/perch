// perch-bg：Bot Group 里的 agent 和 Perch 说话的唯一办法（Bot Group C，2026-10-28）。
//
// agent 之间从不直接对话：想派活、交回、写共享记忆，就在自己的终端里跑一条
// perch-bg 命令。命令把请求交给 Perch 的 Bot Bus（只听 127.0.0.1），由 Perch 认人、
// 过规则、记账、在对方空闲时送达，并画到交接链 / 过程流 / 任务进程上。
// 六个 agent 都会跑命令行，所以一套办法通用，也不用改任何 agent 的全局配置。
//
// 起格时 Perch 给这一格的环境里放：
//
//	PERCH_BG_URL    Bus 的地址（http://127.0.0.1:端口）
//	PERCH_BG_TOKEN  这一格的口令（认出组和角色；格子关了就作废）
//
// 输出约定（借 LayerFS 的结果码）：第一行「结果码 · 一句人话」，agent 读得懂也好解析；
// 退出码 0 成功 · 1 用法错 · 2 被拒 · 3 排队 / 暂停 · 4 连不上 Perch。--json 输出原始 JSON。
// 同一条命令连接出错时用同一个请求 id 重试，Perch 按 id 去重，不会派出两份。
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
)

const usage = `perch-bg —— 在 Perch Bot Group 里派活、交回、写共享记忆

  perch-bg team                                   看团队：每个角色、agent、现在在干什么
  perch-bg handoff --to <角色> --task "<要做什么>" [--accept "<验收标准>"] [--files a,b] [--parent T3]
                                                  把一件事派给某个角色（Perch 在它空闲时送达）
  perch-bg done [--summary "<结果>"] [--task T7] [--files a,b]
                                                  交回当前任务的结果（不交回，这一轮结束时也会自动交回）
  perch-bg tasks                                  看我手上和我派出去的任务
  perch-bg memory add "<要记的事>" [--circle <圈>]  写进共享记忆
  perch-bg memory show [--circle <圈>]            读共享记忆
  perch-bg ping                                   看 Perch 在不在

  文字参数写 - 表示从标准输入读（长文本用）。加 --json 输出原始 JSON。`

type reply struct {
	Code string          `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data,omitempty"`
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, os.Stdin, os.Getenv)) }

func run(args []string, out, errOut io.Writer, in io.Reader, getenv func(string) string) int {
	setUTF8Console()
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprintln(out, usage)
		return 0
	}
	op, rest := args[0], args[1:]
	if op == "memory" {
		if len(rest) == 0 || (rest[0] != "add" && rest[0] != "show") {
			fmt.Fprintln(errOut, "用法：perch-bg memory add \"…\" | perch-bg memory show")
			return 1
		}
		op, rest = "memory."+rest[0], rest[1:]
	}
	flags, pos, jsonOut, err := parseFlags(rest, in)
	if err != nil {
		fmt.Fprintln(errOut, "perch-bg：", err)
		return 1
	}
	body := map[string]any{}
	for k, v := range flags {
		body[k] = v
	}
	switch op {
	case "ping", "team", "tasks", "memory.show":
	case "handoff":
		if flags["to"] == "" || flags["task"] == "" {
			fmt.Fprintln(errOut, "用法：perch-bg handoff --to <角色> --task \"<要做什么>\"")
			return 1
		}
	case "done":
	case "memory.add":
		text := strings.TrimSpace(strings.Join(pos, " "))
		if text == "-" {
			b, _ := io.ReadAll(in)
			text = strings.TrimSpace(string(b))
		}
		if text == "" {
			fmt.Fprintln(errOut, "用法：perch-bg memory add \"<要记的事>\"")
			return 1
		}
		body["text"] = text
	default:
		fmt.Fprintf(errOut, "perch-bg：不认识的命令 %q\n\n%s\n", op, usage)
		return 1
	}
	url, token := strings.TrimRight(getenv("PERCH_BG_URL"), "/"), getenv("PERCH_BG_TOKEN")
	if url == "" || token == "" {
		fmt.Fprintln(out, "unreachable · 这个终端不是 Perch Bot Group 里的格子（没有 PERCH_BG_URL / PERCH_BG_TOKEN）")
		return 4
	}
	body["rid"] = newID()
	r, err := post(url+"/v1/"+op, token, body)
	if err != nil {
		fmt.Fprintf(out, "unreachable · 连不上 Perch：%v\n", err)
		return 4
	}
	if jsonOut {
		b, _ := json.MarshalIndent(r, "", "  ")
		fmt.Fprintln(out, string(b))
	} else {
		fmt.Fprintf(out, "%s · %s\n", r.Code, r.Msg)
	}
	return exitCode(r.Code)
}

// parseFlags：--name value / --name=value；文字参数写 - 从标准输入读。
func parseFlags(args []string, in io.Reader) (map[string]string, []string, bool, error) {
	flags := map[string]string{}
	var pos []string
	jsonOut := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--json" {
			jsonOut = true
			continue
		}
		if !strings.HasPrefix(a, "--") {
			pos = append(pos, a)
			continue
		}
		name, val, has := strings.Cut(strings.TrimPrefix(a, "--"), "=")
		if !has {
			if i+1 >= len(args) {
				return nil, nil, false, fmt.Errorf("--%s 后面缺值", name)
			}
			i++
			val = args[i]
		}
		if val == "-" {
			b, err := io.ReadAll(in)
			if err != nil {
				return nil, nil, false, err
			}
			val = strings.TrimSpace(string(b))
		}
		flags[name] = val
	}
	return flags, pos, jsonOut, nil
}

func post(url, token string, body map[string]any) (reply, error) {
	b, _ := json.Marshal(body)
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 400 * time.Millisecond)
		}
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Perch-Token", token)
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		var r reply
		err = json.NewDecoder(resp.Body).Decode(&r)
		resp.Body.Close()
		if err != nil {
			return reply{}, fmt.Errorf("Perch 的回答看不懂（HTTP %d）", resp.StatusCode)
		}
		return r, nil
	}
	return reply{}, lastErr
}

// 结果码的前缀决定退出码：ok → 0，refused → 2，queued / paused → 3。
func exitCode(code string) int {
	switch {
	case strings.HasPrefix(code, "ok"):
		return 0
	case strings.HasPrefix(code, "queued"), strings.HasPrefix(code, "paused"):
		return 3
	default:
		return 2
	}
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Windows 控制台默认按本地代码页输出：不切 UTF-8 的话中文在 agent 的终端里是乱码。
func setUTF8Console() {
	k, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return
	}
	if p, err := k.FindProc("SetConsoleOutputCP"); err == nil {
		_, _, _ = p.Call(65001)
	}
}
