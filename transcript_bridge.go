package main

// 转录跟随器的旧名字接缝：实现在 internal/transcript，root 在 6a 收掉。

import (
	"time"

	"github.com/yu7dan/perch/internal/transcript"
)

// transcriptFollower 在 main 的启动流程里由 startTranscriptFollower 建一次；
// 之后的快照请求都走它（ctl 拆出去后改由 ctl 持有）。
var transcriptFollower *transcript.Follower

// startTranscriptFollower 把活格子名单与推送注入跟随器，然后起协程。
func startTranscriptFollower(push func(any)) {
	transcriptFollower = transcript.New(func() []transcript.View {
		live := tabs.Live()
		views := make([]transcript.View, 0, len(live))
		for _, v := range live {
			views = append(views, transcript.View{ID: v.ID, Transcript: v.Transcript, CWD: v.CWD})
		}
		return views
	}, push)
	transcriptFollower.Start()
}

// actSnapshot 向跟随器要一份流水副本；nil = 没问到（不是"空"）。
func actSnapshot(tab int, wait time.Duration) []transcript.ActItem {
	if transcriptFollower == nil {
		return nil
	}
	return transcriptFollower.Acts(tab, wait)
}

// filesSnapshot 向跟随器要一份文件台账副本；nil = 没问到。
func filesSnapshot(tab int, wait time.Duration) []transcript.FileTouch {
	if transcriptFollower == nil {
		return nil
	}
	return transcriptFollower.Files(tab, wait)
}

// diffSnapshot 向跟随器要一份某文件的改动副本；nil = 没问到。
func diffSnapshot(tab int, path string, wait time.Duration) *transcript.DiffReply {
	if transcriptFollower == nil {
		return nil
	}
	return transcriptFollower.Diff(tab, path, wait)
}
