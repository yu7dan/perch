// Package perch 只做一件事：把前端资产编进二进制。
//
// 仓库根不是程序入口（入口在 cmd/perch）：这里保持 package perch，是为了让
// //go:embed 的路径仍然相对模块根，同时让 cmd/perch 通过 import 拿到 Assets。
package perch

import "embed"

// Assets 是 assets/ 下的全部前端文件（index.html、css、js、vendor、字体、图标）。
//
// ⚠️ 改了 assets 必须重新 go build：go:embed 在编译期把文件内容写进二进制，
// 只重启进程不会看到新内容。
//
//go:embed assets
var Assets embed.FS
