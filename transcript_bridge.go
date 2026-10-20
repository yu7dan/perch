package main

// 转录跟随器的旧名字接缝：实现在 internal/transcript，root 在 6b 收掉。

import "github.com/yu7dan/perch/internal/transcript"

// transcriptFollower 在 main 的启动流程里由 startTranscriptFollower 建一次；
// 之后的快照请求都走它（ctl 持有同一个指针）。
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
