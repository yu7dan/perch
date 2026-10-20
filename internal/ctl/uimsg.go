package ctl

import "github.com/yu7dan/perch/internal/uimsg"

// withUIErr attaches an error to an outgoing payload (see uimsg.Fields for the
// wire shape). Kept as a package-local name so ctl handlers read short.
func withUIErr(m map[string]any, err error) map[string]any {
	return uimsg.Fields(m, err)
}
