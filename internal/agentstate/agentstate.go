// Package agentstate 保存每个 agent 的接入进度（从零到完整/可用）。
//
// 它不是能力表：能力在 internal/agent 的 Caps 里，探测在 agentcatalog。
// 这里只回答“这个用户在这个安装上走到哪一步了、上次是什么结果、下一步是什么”。
//
// 只存分类和证据，不存 prompt、tool 参数、key、token、magpie 响应正文。
package agentstate

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Version 是落盘格式版本。未来版本的文件只读，不覆盖。
const Version = 1

// 步骤状态。缺省（空）由前端当成 todo。
type StepState string

const (
	StepTodo          StepState = "todo"
	StepDoing         StepState = "doing"
	StepDone          StepState = "done"
	StepFailed        StepState = "failed"
	StepUnsupported   StepState = "unsupported"
	StepNotApplicable StepState = "not_applicable"
)

// 步骤名。前端按这七个名字画时间线；加步骤要同步 08-agent-model.js。
const (
	StepDetect  = "detect"
	StepInstall = "install"
	StepLaunch  = "launch"
	StepAuth    = "auth"
	StepStatus  = "status"
	StepResume  = "resume"
	StepGateway = "gateway"
)

// Step 是一步的结果。Evidence 只放可公开的短证据（例如 pane=58、mechanism=hook），
// 不放原始错误正文、prompt、工具参数或任何凭据。
type Step struct {
	State     StepState `json:"state"`
	At        string    `json:"at,omitempty"`
	Mechanism string    `json:"mechanism,omitempty"`
	Source    string    `json:"source,omitempty"`
	ErrorCode string    `json:"errorCode,omitempty"`
	Verified  bool      `json:"verified,omitempty"`
	Evidence  string    `json:"evidence,omitempty"`
}

// Record 是一个 agent 的接入记录。
type Record struct {
	Steps           map[string]Step `json:"steps,omitempty"`
	LastLaunchAt    string          `json:"lastLaunchAt,omitempty"`
	LaunchCount     int             `json:"launchCount,omitempty"`
	Readiness       string          `json:"readiness,omitempty"`
	ReadinessAt     string          `json:"readinessAt,omitempty"`
	ReadinessSource string          `json:"readinessSource,omitempty"`
}

type fileData struct {
	Version int               `json:"version"`
	Agents  map[string]Record `json:"agents"`
}

// Store 是线程安全的落盘 store。零值不可用；用 Open。
type Store struct {
	path     string
	mu       sync.Mutex
	data     fileData
	readOnly bool
	onChange func(map[string]Record)
}

// Open 读取（或初始化）接入记录。坏文件会被改名成 *.bad-<ts> 后重新开始，
// 未来版本只读；这两种情况都不阻塞产品启动。
func Open(path string) *Store {
	s := &Store{
		path: path,
		data: fileData{Version: Version, Agents: map[string]Record{}},
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[agentstate] 读取失败（按空记录继续）：%v", err)
		}
		return s
	}
	var d fileData
	if err := json.Unmarshal(b, &d); err != nil {
		bad := fmt.Sprintf("%s.bad-%d", path, time.Now().Unix())
		if rerr := os.Rename(path, bad); rerr == nil {
			log.Printf("[agentstate] 记录不是合法 JSON，已改名为 %s：%v", bad, err)
		} else {
			log.Printf("[agentstate] 记录不是合法 JSON，且改名失败：%v", err)
		}
		return s
	}
	if d.Version > Version {
		s.readOnly = true
		log.Printf("[agentstate] 记录版本 %d 高于本程序 %d：只读，不覆盖", d.Version, Version)
	}
	if d.Agents == nil {
		d.Agents = map[string]Record{}
	}
	if d.Version == 0 {
		d.Version = Version
	}
	s.data = d
	return s
}

// SetReadOnly 让本进程只读（第二个实例）：内存照常读，但不写盘，
// 免得两个实例互相当对方的最后一次写入。
func (s *Store) SetReadOnly(reason string) {
	s.mu.Lock()
	s.readOnly = true
	s.mu.Unlock()
	log.Printf("[agentstate] 只读：%s", reason)
}

// SetOnChange 注册变更回调。回调在锁外执行，拿到的是快照。
func (s *Store) SetOnChange(fn func(map[string]Record)) {
	s.mu.Lock()
	s.onChange = fn
	s.mu.Unlock()
}

// Snapshot 返回一份深拷贝。
func (s *Store) Snapshot() map[string]Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return snapshot(s.data.Agents)
}

func snapshot(in map[string]Record) map[string]Record {
	out := make(map[string]Record, len(in))
	for id, r := range in {
		steps := make(map[string]Step, len(r.Steps))
		for k, v := range r.Steps {
			steps[k] = v
		}
		r.Steps = steps
		out[id] = r
	}
	return out
}

// RecordLaunch 记一次启动尝试。成功和失败都记，失败保留稳定错误码。
func (s *Store) RecordLaunch(agent string, paneID int, ok bool, errorCode string) {
	if agent == "" {
		return
	}
	s.mutate(agent, func(r *Record) {
		now := now()
		st := Step{State: StepDone, At: now, Verified: true}
		if !ok {
			st = Step{State: StepFailed, At: now, ErrorCode: errorCode}
		}
		if paneID > 0 {
			st.Evidence = fmt.Sprintf("pane=%d", paneID)
		}
		r.Steps[StepLaunch] = st
		r.LastLaunchAt = now
		r.LaunchCount++
	})
}

// RecordReadiness 记首屏/探测得到的就绪状态。只接受已知分类。
func (s *Store) RecordReadiness(agent, readiness, source string) {
	switch readiness {
	case "ready", "needs-login", "needs-key", "needs-setup", "unknown":
	default:
		return
	}
	if agent == "" {
		return
	}
	// 同一个分类/来源重复到达不重写（状态事件每次轮询都会带一次 ready）。
	s.mu.Lock()
	cur := s.data.Agents[agent]
	same := cur.Readiness == readiness && cur.ReadinessSource == source
	s.mu.Unlock()
	if same {
		return
	}
	s.mutate(agent, func(r *Record) {
		now := now()
		r.Readiness = readiness
		r.ReadinessAt = now
		r.ReadinessSource = source
		st := Step{State: StepTodo, At: now, Source: source}
		switch readiness {
		case "ready":
			st.State = StepDone
			st.Verified = true
		case "needs-setup":
			st.State = StepTodo
		case "unknown":
			st.State = StepTodo
		}
		r.Steps[StepAuth] = st
	})
}

// SetStep 写一条任意步骤（状态/续接/网关由各自的适配器调用）。
func (s *Store) SetStep(agent, step string, st Step) {
	switch step {
	case StepDetect, StepInstall, StepLaunch, StepAuth, StepStatus, StepResume, StepGateway:
	default:
		return
	}
	if agent == "" {
		return
	}
	// 同一条事实重复到达（状态适配器每次轮询都会调它）不重写盘：
	// 除了 At，其余字段一样就算“没有变化”。
	s.mu.Lock()
	cur, had := s.data.Agents[agent].Steps[step]
	s.mu.Unlock()
	if had && cur.State == st.State && cur.Mechanism == st.Mechanism &&
		cur.Source == st.Source && cur.ErrorCode == st.ErrorCode &&
		cur.Verified == st.Verified && cur.Evidence == st.Evidence {
		return
	}
	s.mutate(agent, func(r *Record) {
		if st.At == "" {
			st.At = now()
		}
		r.Steps[step] = st
	})
}

// SetGateway 记 magpie 接线的结果。wired=true 才算 verified；drift/error 只记码。
func (s *Store) SetGateway(agent string, wired bool, errorCode string) {
	if agent == "" {
		return
	}
	s.mutate(agent, func(r *Record) {
		st := Step{State: StepTodo, At: now(), Mechanism: "magpie"}
		if wired {
			st.State = StepDone
			st.Verified = true
		} else if errorCode != "" {
			st.State = StepFailed
			st.ErrorCode = errorCode
		}
		r.Steps[StepGateway] = st
	})
}

func (s *Store) mutate(agent string, fn func(*Record)) {
	s.mu.Lock()
	if s.data.Agents == nil {
		s.data.Agents = map[string]Record{}
	}
	r := s.data.Agents[agent]
	if r.Steps == nil {
		r.Steps = map[string]Step{}
	}
	fn(&r)
	s.data.Agents[agent] = r
	s.saveLocked()
	snap := snapshot(s.data.Agents)
	cb := s.onChange
	s.mu.Unlock()
	if cb != nil {
		cb(snap)
	}
}

func (s *Store) saveLocked() {
	if s.readOnly || s.path == "" {
		return
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[agentstate] 建目录失败：%v", err)
		return
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		log.Printf("[agentstate] 编码失败：%v", err)
		return
	}
	f, err := os.CreateTemp(dir, ".agent-state-*.tmp")
	if err != nil {
		log.Printf("[agentstate] 建临时文件失败：%v", err)
		return
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(b); err != nil {
		f.Close()
		log.Printf("[agentstate] 写临时文件失败：%v", err)
		return
	}
	if err := f.Close(); err != nil {
		log.Printf("[agentstate] 关临时文件失败：%v", err)
		return
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		log.Printf("[agentstate] 设置权限失败：%v", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		log.Printf("[agentstate] 落盘失败：%v", err)
	}
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }
