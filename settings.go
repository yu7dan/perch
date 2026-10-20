package main

// 设置页的载荷与落点。设置本体的落盘、归一化在 internal/settings；
// 这里只做两件属于编排的事：
//
//  1. 拼发给前端的整份读数（要问项目池要内置默认目录，属于上层知识）；
//  2. settings.set 之后，若默认目录变了，确保新目录存在并重算池子。
//
// ⚠️ 默认目录是**后端的事实**，不是前端的 localStorage：defaultCWD()、新格的
// 实际 PTY cwd、合成的「默认工作区」、状态栏都从这一份读。前端那份缓存只负责
// 首帧和启动落点，Go 的载荷一到就以 Go 为准（见 05-prefs.js）。

import (
	"log"
	"strings"

	"github.com/yu7dan/perch/internal/settings"
)

type appSettings = settings.Settings
type settingsPatch = settings.Patch
type settingsStore = settings.Store

func settingsDefaults() appSettings { return settings.Defaults() }

func loadSettingsStore() *settingsStore { return settings.Load() }

func pick(s, alt string) string {
	if strings.TrimSpace(s) == "" {
		return alt
	}
	return s
}

// settingsWire 是发给前端的整份读数。除了落盘的七项，还带上**算出来的**三样：
//
//	· cwd             当前生效的默认工作目录（自定义失效时是内置那个）
//	· builtinCwd      内置默认目录，设置页拿它写"恢复默认"的说明
//	· defaultCwdMissing 用户选的目录此刻不在盘上（不代表配置坏了）
//
// 这三个数都由 Go 现算：前端自己拼路径会在「文档/Documents」这种地方分叉。
func settingsWire(errMsg string) map[string]any {
	m := map[string]any{"type": "settings"}
	if prefsStore == nil {
		m["settings"] = settingsDefaults()
		m["err"] = "设置存储没起来（拿不到用户配置目录）"
		return m
	}
	st := prefsStore.Snapshot()
	builtin, _ := builtinDefaultWorkspacePath()
	m["settings"] = st
	m["cwd"] = defaultCWD()
	m["builtinCwd"] = builtin
	m["defaultCwdMissing"] = prefsStore.DefaultCWDUnavailable()
	if errMsg != "" {
		m["err"] = errMsg
	}
	return m
}

func pushSettings(errMsg string) {
	pushJSON(settingsWire(errMsg))
}

// applySettingsPatch 是 settings.set / settings.pickDefaultCWD 的共同落点。
// 默认目录一变，还要做两件事：确保新目录存在（新格要落在里面），并把池子
// 重算一遍（合成的「默认工作区」那一行跟着换路径）。
func applySettingsPatch(p settingsPatch, why string) {
	if prefsStore == nil {
		pushSettings("设置存储没起来（拿不到用户配置目录）")
		return
	}
	old := prefsStore.Snapshot()
	next, err := prefsStore.Patch(p)
	if err != nil {
		log.Printf("[settings] %s 失败：%v（保持原值）", why, err)
		pushSettings(err.Error())
		return
	}
	log.Printf("[settings] %s：默认目录=%s 字号=%d 字体=%s 启动=%s 默认 agent=%s 快捷键=%s 关窗确认=%v 结束确认=%v",
		why, pick(next.DefaultCWD, "(内置)"), next.TermFontSize, next.TermFontFamily,
		next.StartView, pick(next.DefaultAgent, "(自动)"), pick(next.NewAgentShortcut, "(关闭)"),
		next.ConfirmClose, next.ConfirmEndAgent)
	pushSettings("")
	if next.DefaultCWD != old.DefaultCWD {
		ensureDefaultWorkspace()
		poolReply("")
	}
}
