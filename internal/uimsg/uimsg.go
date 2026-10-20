// Package uimsg carries the identity of a user-facing message across the
// Go → JS boundary.
//
// A message has a stable Code, optional Params, and the raw Text that was shown
// before localization existed. The frontend renders msg.<code> in the current
// language and falls back to Text whenever it has no entry for that code
// (an older frontend, a newer backend, or an OS error nobody translated).
//
// The text is intentionally kept in the message instead of being derived from
// the code: logs and old clients must keep reading something a human can act
// on, and a missing dictionary entry must never surface as a bare key.
package uimsg

import "errors"

// Msg is the wire shape. It is embedded in Error and also usable on its own
// for non-error notices.
type Msg struct {
	Code   string            `json:"code,omitempty"`
	Params map[string]string `json:"params,omitempty"`
	Text   string            `json:"text,omitempty"`
}

// Empty reports whether this message carries nothing worth sending.
func (m Msg) Empty() bool { return m.Code == "" && m.Text == "" }

// Error is an error with a stable UI identity. Error() returns Text, so every
// existing log line keeps reading exactly as it did before.
type Error struct {
	Msg
	cause error
}

func (e *Error) Error() string { return e.Text }
func (e *Error) Unwrap() error { return e.cause }

// New builds a coded message with a raw fallback.
func New(code, text string) *Error {
	return &Error{Msg: Msg{Code: code, Text: text}}
}

// NewParams builds a coded message with placeholders for the frontend.
// text should already contain the same values, so the fallback is readable.
func NewParams(code, text string, params map[string]string) *Error {
	return &Error{Msg: Msg{Code: code, Text: text, Params: params}}
}

// Wrap adds a UI identity to an existing error while keeping errors.Is/As
// working through Unwrap.
func Wrap(err error, code, text string, params map[string]string) *Error {
	return &Error{Msg: Msg{Code: code, Text: text, Params: params}, cause: err}
}

// From extracts the UI identity from an error chain. ok is false for ordinary
// errors, whose Text is then the only thing the UI can show.
func From(err error) (Msg, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e.Msg, true
	}
	return Msg{}, false
}
