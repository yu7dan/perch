package botgroup

// 每个 Bot 一个 git worktree（Bot Group C，架构页第十一节第 1 条；规矩借 LayerFS：
// 每个 agent 一个分支、冲突归合并的人、只有主 agent 并回主分支）。
//
//	<项目>/.perch/wt/<组>/<Bot id>   分支 bg/<组>/<Bot id>
//
// Perch 只负责建好、交回时记下分支和提交；合并是 Manager 自己用 git 做的（它是 agent，会跑命令）。
// .perch/ 写进 .git/info/exclude（不碰用户的 .gitignore），免得 worktree 出现在 git status 里。
// 不建的情况：不是 git 仓库 / Manager / 只读 / 自定义了文件夹。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// IsGitRepo：dir 是不是一个 git 仓库的工作目录（含子目录）。
func IsGitRepo(dir string) bool {
	if dir == "" {
		return false
	}
	out, err := git(dir, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

// WantsWorktree：这个 Bot 该不该有自己的 worktree。
func WantsWorktree(g Group, b Bot) bool {
	return g.Worktrees && !b.Manager && b.Permission != "read-only" && b.Folder == "" && IsGitRepo(g.Project)
}

// EnsureWorktree 给 Bot 建好 worktree（已经有就直接返回）。
func EnsureWorktree(g Group, b Bot) (path, branch string, err error) {
	path = filepath.Join(g.Project, ".perch", "wt", g.ID, b.ID)
	branch = "bg/" + g.ID + "/" + b.ID
	if fi, err := os.Stat(filepath.Join(path, ".git")); err == nil && !fi.IsDir() {
		return path, branch, nil
	}
	excludePerch(g.Project)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", "", err
	}
	if _, err := git(g.Project, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch); err == nil {
		_, err = git(g.Project, "worktree", "add", path, branch)
		return path, branch, err
	}
	if _, err := git(g.Project, "worktree", "add", "-b", branch, path); err != nil {
		return "", "", err
	}
	return path, branch, nil
}

// HeadInfo：worktree 当前的短提交号和还没提交的改动数（交回时记进任务）。
func HeadInfo(dir string) (commit string, dirty int) {
	if out, err := git(dir, "rev-parse", "--short", "HEAD"); err == nil {
		commit = strings.TrimSpace(out)
	}
	if out, err := git(dir, "status", "--porcelain"); err == nil {
		for _, l := range strings.Split(out, "\n") {
			if strings.TrimSpace(l) != "" {
				dirty++
			}
		}
	}
	return
}

// excludePerch 把 .perch/ 加进 .git/info/exclude（已经有就不动）。
func excludePerch(project string) {
	out, err := git(project, "rev-parse", "--git-common-dir")
	if err != nil {
		return
	}
	gd := strings.TrimSpace(out)
	if !filepath.IsAbs(gd) {
		gd = filepath.Join(project, gd)
	}
	p := filepath.Join(gd, "info", "exclude")
	data, _ := os.ReadFile(p)
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) == ".perch/" {
			return
		}
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	add := ".perch/\n"
	if len(data) > 0 && !strings.HasSuffix(string(data), "\n") {
		add = "\n" + add
	}
	fh, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		_, _ = fh.WriteString(add)
		fh.Close()
	}
}

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s：%s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
