package main

// 设置存储的旧名字接缝：实现在 internal/settings，root 在 6b 收掉。
// 设置的载荷与编排（settingsWire / applySettingsPatch）已经搬进 internal/ctl。

import "github.com/yu7dan/perch/internal/settings"

type settingsStore = settings.Store

func loadSettingsStore() *settingsStore { return settings.Load() }
