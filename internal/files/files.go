// Package files 是只读文件树的数据腿。
//
// 为什么要有这一条腿：agent 产出的文件/代码就在工作区目录里，而 Perch 之前
// 只能把用户交给资源管理器。用户 2026-10-19 要的是"在这一列里就能点开看"，
// 所以新增两条**只读**控制消息（fs.list / fs.read）。
//
// 护栏（这是**唯一**一条把盘上任意内容读回页面的路，不能只靠前端守）：
//   - root 必须在项目池（含合成的默认工作区）里 —— 不是"绝对路径就行"；
//   - 目标必须**规范化后**仍落在 root 里（EvalSymlinks 之后再比），
//     所以 `..` 和指向外面的符号链接都过不去；
//   - 只读、只读普通文件；目录只能列、不能当文件读；
//   - 单次目录最多 2000 条、单文件最多 512 KiB（超出标 truncated，不报错）；
//   - 二进制/非 UTF-8 不往页面上送正文，只回标记。
//
// ⚠️ 不做 fs.write / fs.delete。文件的写入权在 agent 手里，这个模块只负责看。
//
// 允许根由调用方注入（`Roots func() []string`），所以这个包不 import 项目池。
package files

import (
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/yu7dan/perch/internal/uimsg"
)

const (
	MaxEntries   = 2000
	MaxFileBytes = 512 * 1024
)

// Entry 是目录里的一行。
type Entry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Rel  string `json:"rel"`
	Dir  bool   `json:"dir"`
	Link bool   `json:"link,omitempty"`
	// External = 符号链接指向 root 外面。前端把它画成"看得到、打不开"，
	// 而不是从列表里删掉 —— 静默消失比一句解释更难查。
	External bool  `json:"external,omitempty"`
	Hidden   bool  `json:"hidden,omitempty"`
	Size     int64 `json:"size,omitempty"`
	Mod      int64 `json:"mod,omitempty"` // Unix 毫秒
}

// ListResult 是 fs.list 的载荷。
type ListResult struct {
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated"`
}

// ReadResult 是 fs.read 的载荷。
type ReadResult struct {
	Path      string `json:"path"`
	Rel       string `json:"rel"`
	Size      int64  `json:"size"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	Encoding  string `json:"encoding"` // utf-8 | utf-16le | utf-16be | non-utf8
}

// Service 把"哪些目录可以被打开"绑到这条腿上。
type Service struct {
	Roots func() []string
}

// List 先查 root 的允许性，再列目录。
func (s *Service) List(root, dir string) (ListResult, error) {
	roots := []string(nil)
	if s != nil && s.Roots != nil {
		roots = s.Roots()
	}
	if !RootAllowed(root, roots) {
		return ListResult{}, ErrRootNotAllowed
	}
	return ListDir(root, dir)
}

// Read 先查 root 的允许性，再读文件。
func (s *Service) Read(root, path string) (ReadResult, error) {
	roots := []string(nil)
	if s != nil && s.Roots != nil {
		roots = s.Roots()
	}
	if !RootAllowed(root, roots) {
		return ReadResult{}, ErrRootNotAllowed
	}
	return ReadFile(root, path)
}

// ErrRootNotAllowed 是护栏对外的唯一说法；调用方据此回 fs.err。
var ErrRootNotAllowed = uimsg.New("files.rootNotAllowed", "这个目录不在工作区里")

// failed 把底层 IO 错误包成带稳定 code 的消息；OS 原文作为 {err} 传给前端。
func failed(code, format string, err error) error {
	return uimsg.Wrap(err, code, fmt.Sprintf(format, err), map[string]string{"err": err.Error()})
}

// Resolve 把用户给的路径变成**真实**绝对路径：
//
//	绝对路径 → Clean → EvalSymlinks。
//
// EvalSymlinks 是关键：只做 filepath.Clean 的话，一个指向项目外的目录联接
// （Windows 的 junction 很常见）就能绕过包含性检查。
func Resolve(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", uimsg.New("files.emptyPath", "空路径")
	}
	if !filepath.IsAbs(p) {
		return "", uimsg.NewParams("files.notAbsolute",
			fmt.Sprintf("不是绝对路径：%s", p), map[string]string{"path": p})
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", failed("files.badPath", "这个路径看不懂：%v", err)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", failed("files.unresolvable", "这个路径解析不了：%v", err)
	}
	return real, nil
}

func pathKey(p string) string {
	return strings.ToLower(filepath.Clean(strings.TrimSpace(p)))
}

// InsidePath 判断 target 是否等于 root 或落在 root 里面。
// 用大小写不敏感 + Clean 比较，并显式补分隔符 ——
// 否则 `C:\a` 会把 `C:\ab` 误判成自己的子目录。
func InsidePath(root, target string) bool {
	r, t := pathKey(root), pathKey(target)
	if r == "" || t == "" {
		return false
	}
	if r == t {
		return true
	}
	sep := string(os.PathSeparator)
	if !strings.HasSuffix(r, sep) {
		r += sep
	}
	return strings.HasPrefix(t, r)
}

// AllowedRoots 是"哪些目录可以被文件树打开"的来源。调用方传入项目池与
// 默认工作区；别把"当前格的 cwd"加进来 —— cwd 可能在任何地方，而这条腿的
// 边界必须由用户显式收进池子的目录来定义。
func AllowedRoots(roots ...[]string) []string {
	var out []string
	for _, group := range roots {
		for _, p := range group {
			if strings.TrimSpace(p) != "" {
				out = append(out, p)
			}
		}
	}
	return out
}

// RootAllowed 只接受**恰好等于**某个允许根（规范化之后）的 root。
// 不做"在某个允许根下面也算" —— 树里的子目录由 ListDir 的包含性检查管，
// 入口这一层收窄一点，出错面就小一点。
func RootAllowed(root string, allowed []string) bool {
	r, err := Resolve(root)
	if err != nil {
		return false
	}
	for _, a := range allowed {
		ar, err := Resolve(a)
		if err != nil {
			continue
		}
		if pathKey(ar) == pathKey(r) {
			return true
		}
	}
	return false
}

// ListDir 列一个目录。root/dir 都必须是存在的绝对路径；dir 空 = root。
// ⚠️ root 的**允许性**由调用方先查（List 或 RootAllowed），这里只查包含性 ——
// 这样测试可以拿临时目录直接测这一层，不需要造一个项目池。
func ListDir(root, dir string) (ListResult, error) {
	res := ListResult{Entries: []Entry{}}
	rr, err := Resolve(root)
	if err != nil {
		return res, err
	}
	if strings.TrimSpace(dir) == "" {
		dir = root
	}
	dd, err := Resolve(dir)
	if err != nil {
		return res, err
	}
	if !InsidePath(rr, dd) {
		return res, uimsg.New("files.dirOutside", "目录不在这个工作区里")
	}
	res.Path = dd

	ents, err := os.ReadDir(dd)
	if err != nil {
		return res, failed("files.readDirFailed", "列目录失败：%v", err)
	}
	if len(ents) > MaxEntries {
		ents = ents[:MaxEntries]
		res.Truncated = true
	}
	for _, ent := range ents {
		name := ent.Name()
		full := filepath.Join(dd, name)
		e := Entry{
			Name:   name,
			Path:   full,
			Hidden: strings.HasPrefix(name, "."),
		}
		if rel, err := filepath.Rel(rr, full); err == nil {
			e.Rel = filepath.ToSlash(rel)
		}
		if ent.Type()&os.ModeSymlink != 0 {
			e.Link = true
			// 链接指向哪里、还在不在工作区里 —— 只有解开之后才知道。
			// 解不开（断链）也照列：它是盘上真实存在的一个条目。
			if target, err := filepath.EvalSymlinks(full); err == nil {
				if !InsidePath(rr, target) {
					e.External = true
				}
				if fi, err := os.Stat(full); err == nil {
					e.Dir = fi.IsDir()
					e.Size = fi.Size()
					e.Mod = fi.ModTime().UnixMilli()
				}
			}
		} else {
			e.Dir = ent.IsDir()
			if fi, err := ent.Info(); err == nil {
				e.Size = fi.Size()
				e.Mod = fi.ModTime().UnixMilli()
			}
		}
		res.Entries = append(res.Entries, e)
	}
	// 目录在前、同类按名字（大小写不敏感）。和 Orca 的 sortDirEntries 同一条规则：
	// 用户扫树时找的是"哪个文件夹"，不是文件名的字典序。
	sort.SliceStable(res.Entries, func(i, j int) bool {
		a, b := res.Entries[i], res.Entries[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return res, nil
}

// ReadFile 读一个普通文件的**前 512 KiB**，并判断它能不能当文本显示。
func ReadFile(root, path string) (ReadResult, error) {
	res := ReadResult{Encoding: "utf-8"}
	rr, err := Resolve(root)
	if err != nil {
		return res, err
	}
	rp, err := Resolve(path)
	if err != nil {
		return res, err
	}
	if !InsidePath(rr, rp) {
		return res, uimsg.New("files.fileOutside", "文件不在这个工作区里")
	}
	fi, err := os.Stat(rp)
	if err != nil {
		return res, failed("files.statFailed", "读不到文件信息：%v", err)
	}
	if !fi.Mode().IsRegular() {
		return res, uimsg.New("files.notRegular", "不是普通文件")
	}
	res.Path = rp
	res.Size = fi.Size()
	if rel, err := filepath.Rel(rr, rp); err == nil {
		res.Rel = filepath.ToSlash(rel)
	}

	f, err := os.Open(rp)
	if err != nil {
		return res, failed("files.openFailed", "打不开这个文件：%v", err)
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if err != nil {
		return res, failed("files.readFailed", "读不了这个文件：%v", err)
	}
	if len(raw) > MaxFileBytes {
		raw = raw[:MaxFileBytes]
		res.Truncated = true
	}

	text, enc, isBinary := decodeText(raw)
	res.Encoding = enc
	if isBinary || enc == "non-utf8" {
		res.Binary = isBinary
		// 二进制不送正文；非 UTF-8 也不送（送半份乱码比空着更糟）。
		return res, nil
	}
	res.Text = text
	return res, nil
}

// decodeText 判定并解码一份字节。返回值 binary=true 表示"这不是文本"。
// 顺序很重要：
//  1. BOM（UTF-8 / UTF-16）先剥 —— UTF-16 的正文里天然有 0x00，先查 NUL 会把
//     一份正常的 UTF-16 文件误判成二进制；
//  2. 没有 BOM 再看前 8 KiB 有没有 NUL —— 有就是二进制；
//  3. 最后才要求 UTF-8 合法（截断可能切在半个字上，最多回退 3 字节）。
func decodeText(b []byte) (text, enc string, isBinary bool) {
	switch {
	case len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF:
		body := b[3:]
		body = trimPartialRune(body)
		if !utf8.Valid(body) {
			return "", "non-utf8", false
		}
		return string(body), "utf-8", false
	case len(b) >= 2 && b[0] == 0xFF && b[1] == 0xFE:
		return decodeUTF16(b[2:], binary.LittleEndian), "utf-16le", false
	case len(b) >= 2 && b[0] == 0xFE && b[1] == 0xFF:
		return decodeUTF16(b[2:], binary.BigEndian), "utf-16be", false
	}
	head := b
	if len(head) > 8192 {
		head = head[:8192]
	}
	for _, c := range head {
		if c == 0 {
			return "", "binary", true
		}
	}
	body := trimPartialRune(b)
	if !utf8.Valid(body) {
		return "", "non-utf8", false
	}
	return string(body), "utf-8", false
}

// trimPartialRune 只在**末尾**去掉一个被截断的多字节序列：512 KiB 的截断可能
// 正好切在一个汉字的中间；这时整份文件其实是 UTF-8，不该被误报成 non-utf8。
// ⚠️ 不能"往回退到能解码为止"：一份三个 0xFF 的文件退光之后就变成空串了，
// 那会把真正的非 UTF-8 文件静默显示成空文件。只认合法首字节 + 合法续字节。
func trimPartialRune(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		if !utf8.RuneStart(b[i]) {
			continue
		}
		n := utf8SeqLen(b[i])
		if n <= 1 || len(b)-i >= n {
			continue
		}
		ok := true
		for _, c := range b[i+1:] {
			if c&0xC0 != 0x80 {
				ok = false
				break
			}
		}
		if ok && utf8.Valid(b[:i]) {
			return b[:i]
		}
	}
	return b
}

// utf8SeqLen 是首字节期望的序列长度；0 = 不是合法首字节。
func utf8SeqLen(c byte) int {
	switch {
	case c < 0x80:
		return 1
	case c < 0xC2:
		return 0
	case c < 0xE0:
		return 2
	case c < 0xF0:
		return 3
	case c < 0xF5:
		return 4
	default:
		return 0
	}
}

func decodeUTF16(b []byte, order binary.ByteOrder) string {
	if len(b)%2 != 0 {
		b = b[:len(b)-1]
	}
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		u = append(u, order.Uint16(b[i:i+2]))
	}
	return string(utf16.Decode(u))
}
