package ctl

import "github.com/yu7dan/perch/internal/uimsg"

// withUIErr attaches an error to an outgoing payload.
//
// `err` stays the raw text: logs, older frontends, and anything that only
// knows the pre-i18n wire keep working. `errCode` / `errParams` are additive —
// they let the current frontend render the same failure in the user's
// language, and are absent for errors that never got a stable identity.
func withUIErr(m map[string]any, err error) map[string]any {
	if err == nil {
		return m
	}
	m["err"] = err.Error()
	if msg, ok := uimsg.From(err); ok {
		if msg.Code != "" {
			m["errCode"] = msg.Code
		}
		if len(msg.Params) > 0 {
			m["errParams"] = msg.Params
		}
	}
	return m
}
