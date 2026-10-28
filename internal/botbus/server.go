// Package botbus 是 Bot Group 的本机总线（Bot Group C，2026-10-28）：perch-bg 命令行连这里。
//
// 只做传输和认人，规则全在 botgroup.Coordinator：
//   - 只听 127.0.0.1（随机端口），地址和口令起格时放进那一格的环境（PERCH_BG_URL / PERCH_BG_TOKEN）；
//   - 口令只认请求头 X-Perch-Token，不认 cookie；带 Origin 头的请求一律拒绝 ——
//     浏览器里的网页一定带 Origin，命令行不会带（防网页往本机接口发请求）；
//   - 请求体最多 256 KiB。
package botbus

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/yu7dan/perch/internal/botgroup"
)

// Handler 是协调器在总线这边露出来的那一面。
type Handler interface {
	Who(token string) (botgroup.Ident, bool)
	Handle(id botgroup.Ident, op string, body map[string]string) botgroup.Reply
}

// Server 是跑起来的总线。
type Server struct {
	URL string
	ln  net.Listener
	srv *http.Server
}

var ops = map[string]bool{"ping": true, "team": true, "tasks": true, "handoff": true, "done": true, "review": true, "memory.add": true, "memory.show": true}

// Start 在 127.0.0.1 的随机端口上起总线。
func Start(h Handler) (*Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/", func(w http.ResponseWriter, r *http.Request) { serve(h, w, r) })
	s := &Server{URL: "http://" + ln.Addr().String(), ln: ln,
		srv: &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second}}
	go func() {
		if err := s.srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("[botbus] 停了：%v", err)
		}
	}()
	log.Printf("[botbus] 在 %s 上听 perch-bg", s.URL)
	return s, nil
}

func (s *Server) Close() { _ = s.srv.Close() }

func serve(h Handler, w http.ResponseWriter, r *http.Request) {
	reply := func(status int, rp botgroup.Reply) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(rp)
	}
	if r.Method != http.MethodPost {
		reply(http.StatusMethodNotAllowed, botgroup.Reply{Code: "refused:method", Msg: "只收 POST"})
		return
	}
	if r.Header.Get("Origin") != "" {
		reply(http.StatusForbidden, botgroup.Reply{Code: "refused:origin", Msg: "不接受来自网页的请求"})
		return
	}
	id, ok := h.Who(r.Header.Get("X-Perch-Token"))
	if !ok {
		reply(http.StatusUnauthorized, botgroup.Reply{Code: "refused:token", Msg: "口令不对或已经作废（格子重启后用新的终端再试）"})
		return
	}
	op := strings.TrimPrefix(r.URL.Path, "/v1/")
	if !ops[op] {
		reply(http.StatusNotFound, botgroup.Reply{Code: "refused:op", Msg: "不认识的命令 " + op})
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 256<<10))
	if err != nil {
		reply(http.StatusBadRequest, botgroup.Reply{Code: "refused:body", Msg: "读不了请求"})
		return
	}
	body := map[string]string{}
	var generic map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &generic); err != nil {
			reply(http.StatusBadRequest, botgroup.Reply{Code: "refused:body", Msg: "请求不是 JSON"})
			return
		}
	}
	for k, v := range generic {
		if s, ok := v.(string); ok {
			body[k] = s
		}
	}
	rp := h.Handle(id, op, body)
	log.Printf("[botbus] %s/%s %s → %s", id.Group, id.Bot, op, rp.Code)
	reply(http.StatusOK, rp)
}
