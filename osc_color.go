package main

import "github.com/yu7dan/perch/internal/term"

// 这一层只是把旧名字接到 internal/term；实现已经搬走，root 在 6b 收掉。
type oscColorResponder = term.OSCResponder

func newOSCColorResponder() *oscColorResponder { return term.NewOSCResponder() }
