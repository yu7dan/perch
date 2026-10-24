package agent

// ClaudeDef 是 Claude Code 的启动描述：环境根 + 续接参数。
//
// ⚠️ 不写死任何人的绝对路径。exe 由调用方（agentcatalog）解析后传入。
func ClaudeDef(stateDir, exe string) Def {
	return Def{
		Exe: exe,
		// 每次开格重新解析：官方 2.x 安装器把新版本放在 ~/.local/bin，
		// 而 Perch 可能在启动时还没看到它。Bin 让 StartTab 走 ResolveExe，
		// 不再把启动时那个路径钉死。
		Bin: "claude",
		Env: map[string]string{"CLAUDE_CONFIG_DIR": stateDir},
		Args: func(r ResumeIntent, settings string) []string {
			var args []string
			switch r.Kind {
			case "latest":
				args = []string{"--continue"}
			case "exact":
				args = []string{"--resume", r.ID}
			case "fork":
				args = []string{"--resume", r.ID, "--fork-session"}
			}
			// "new"：裸启动就是全新会话，本身不需要参数。
			//
			// ⚠️ 刻意**不用 --session-id 去钉住新会话**：格子↔会话的关联改由
			// claude 自己写的 sessions\<pid>.json 登记表定（见 session/registry.go）——
			// 那条路对 --resume/--continue 一视同仁，也不会多出一个可能和真实
			// 状态不一致的第二事实源。也正因为如此，这里绝不能把 --session-id
			// 和 --resume/--continue 混用：实测重复 id 是**硬失败**（起不来）。
			if settings != "" {
				args = append(args, "--settings", settings)
			}
			return args
		},
	}
}
