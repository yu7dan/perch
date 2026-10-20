package files

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestInsidePath(t *testing.T) {
	tests := []struct {
		root, target string
		want         bool
	}{
		{`C:\work`, `C:\work\a.txt`, true},
		{`C:\work`, `C:\work`, true},
		{`C:\work`, `C:\workshop\a.txt`, false},
		{`C:\Work`, `c:\work\a.txt`, true},
		{`C:\work`, `C:\work\..\secret`, false},
		{`C:\work`, `C:\work\sub\..\..\secret`, false},
		{``, `C:\work`, false},
	}
	for _, tc := range tests {
		if got := InsidePath(tc.root, tc.target); got != tc.want {
			t.Errorf("InsidePath(%q, %q) = %v，想要 %v", tc.root, tc.target, got, tc.want)
		}
	}
}

func TestRootAllowedExactOnly(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if !RootAllowed(root, []string{root}) {
		t.Fatal("根目录本身应该被允许")
	}
	// 允许根下面的子目录**不是**一个合法的根：树是从根一层层往下走的。
	if RootAllowed(sub, []string{root}) {
		t.Fatal("子目录不该被当成合法根")
	}
	if RootAllowed(root, []string{sub}) {
		t.Fatal("父目录不该匹配另一个根")
	}
	// 大小写不同也要认（Windows 路径不区分大小写）。
	if !RootAllowed(strings.ToUpper(root), []string{root}) {
		t.Fatal("大小写不同的同一个路径应该被允许")
	}
}

func TestListDirSortsAndMarks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "zeta"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "Alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"b.txt": "b", "A.txt": "a", ".env": "SECRET=1",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	res, err := ListDir(root, "")
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(res.Entries))
	for _, e := range res.Entries {
		names = append(names, e.Name)
		if e.Rel == "" {
			t.Errorf("条目 %s 没有相对路径", e.Name)
		}
	}
	// 目录优先（Alpha、zeta，大小写不敏感），然后文件按名字（`.` 排在字母前）。
	want := []string{"Alpha", "zeta", ".env", "A.txt", "b.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("排序 = %v，想要 %v", names, want)
	}
	for _, e := range res.Entries {
		if e.Name == ".env" && !e.Hidden {
			t.Error(".env 应该标记为隐藏")
		}
		if (e.Name == "Alpha" || e.Name == "zeta") && !e.Dir {
			t.Errorf("%s 应该标记为目录", e.Name)
		}
	}
}

func TestListDirRejectsEscape(t *testing.T) {
	root := t.TempDir()
	if _, err := ListDir(root, filepath.Join(root, "..")); err == nil {
		t.Fatal("列 root 的父目录应该被拒绝")
	}
}

func TestListDirMarksExternalSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "out")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("这台机器建不了符号链接（%v），跳过", err)
	}
	res, err := ListDir(root, "")
	if err != nil {
		t.Fatal(err)
	}
	var found *Entry
	for i := range res.Entries {
		if res.Entries[i].Name == "out" {
			found = &res.Entries[i]
		}
	}
	if found == nil {
		t.Fatal("指向外面的链接应该仍然列出来")
	}
	if !found.Link || !found.External {
		t.Fatalf("指向外面的链接应标记 link+external，实际 %+v", *found)
	}
	if _, err := ListDir(root, link); err == nil {
		t.Fatal("把外部链接当目录展开应该被拒绝")
	}
}

func TestReadText(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "a.txt")
	if err := os.WriteFile(file, []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != "hello\nworld\n" || res.Binary || res.Encoding != "utf-8" {
		t.Fatalf("读到 %+v", res)
	}
	if res.Size != 12 || res.Rel != "a.txt" {
		t.Fatalf("大小/相对路径不对：%+v", res)
	}
}

func TestReadTruncatesAtCap(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "big.txt")
	if err := os.WriteFile(file, []byte(strings.Repeat("a", MaxFileBytes+10)), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated {
		t.Fatal("大文件应该标记 truncated")
	}
	if len(res.Text) != MaxFileBytes {
		t.Fatalf("正文长度 = %d，想要 %d", len(res.Text), MaxFileBytes)
	}
}

func TestReadKeepsURuneWhenTruncated(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "cut.txt")
	// 让 512 KiB 正好切在一个三字节汉字的中间：填一个 ASCII 字节，剩下全是「汉」。
	body := "x" + strings.Repeat("汉", (MaxFileBytes/3)+10)
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Encoding != "utf-8" || res.Binary {
		t.Fatalf("截断在半个字上不该把文件判成非 UTF-8：%+v", res)
	}
}

func TestReadBinary(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "bin.dat")
	if err := os.WriteFile(file, []byte{0x00, 0x01, 0x02, 0xff}, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Binary || res.Text != "" {
		t.Fatalf("二进制文件不该回正文：%+v", res)
	}
}

func TestReadNonUTF8(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "gbk.txt")
	// 一个不含 NUL、又不是合法 UTF-8 的字节序列。
	if err := os.WriteFile(file, []byte{0xff, 0xff, 0xff}, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Binary || res.Encoding != "non-utf8" || res.Text != "" {
		t.Fatalf("非 UTF-8 应只回标记：%+v", res)
	}
}

func TestReadUTF16(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "u16.txt")
	u := utf16.Encode([]rune("你好\n"))
	b := []byte{0xFF, 0xFE}
	for _, v := range u {
		b = append(b, byte(v), byte(v>>8))
	}
	if err := os.WriteFile(file, b, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ReadFile(root, file)
	if err != nil {
		t.Fatal(err)
	}
	if res.Encoding != "utf-16le" || res.Text != "你好\n" {
		t.Fatalf("UTF-16LE 解码不对：%+v", res)
	}
}

func TestReadRejectsEscapeAndDirs(t *testing.T) {
	root := t.TempDir()
	outside, err := os.CreateTemp(filepath.Dir(root), "perch-outside-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	outside.WriteString("outside")
	outside.Close()
	t.Cleanup(func() { os.Remove(outside.Name()) })

	if _, err := ReadFile(root, outside.Name()); err == nil {
		t.Fatal("读 root 外面的文件应该被拒绝")
	}
	if _, err := ReadFile(root, root); err == nil {
		t.Fatal("把目录当文件读应该被拒绝")
	}
}

func TestServiceRejectsUnknownRoot(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	s := &Service{Roots: func() []string { return []string{other} }}
	if _, err := s.List(root, ""); err != ErrRootNotAllowed {
		t.Fatalf("不在允许根里的目录应被拒绝，实际 %v", err)
	}
	if _, err := s.Read(root, filepath.Join(root, "x")); err != ErrRootNotAllowed {
		t.Fatalf("读取也应先查允许根，实际 %v", err)
	}
}
