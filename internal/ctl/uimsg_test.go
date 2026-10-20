package ctl

import (
	"errors"
	"testing"

	"github.com/yu7dan/perch/internal/uimsg"
)

func TestWithUIErrKeepsRawTextAndAddsCode(t *testing.T) {
	base := errors.New("access denied")
	err := uimsg.Wrap(base, "settings.saveFailed", "设置没写成：access denied",
		map[string]string{"err": "access denied"})

	m := withUIErr(map[string]any{"type": "settings"}, err)
	if m["err"] != "设置没写成：access denied" {
		t.Fatalf("raw err = %v", m["err"])
	}
	if m["errCode"] != "settings.saveFailed" {
		t.Fatalf("errCode = %v", m["errCode"])
	}
	params, ok := m["errParams"].(map[string]string)
	if !ok || params["err"] != "access denied" {
		t.Fatalf("errParams = %#v", m["errParams"])
	}
}

func TestWithUIErrPlainErrorHasNoCodeFields(t *testing.T) {
	m := withUIErr(map[string]any{}, errors.New("plain"))
	if m["err"] != "plain" {
		t.Fatalf("err = %v", m["err"])
	}
	if _, ok := m["errCode"]; ok {
		t.Fatalf("plain errors must not gain an errCode: %#v", m)
	}
	if _, ok := m["errParams"]; ok {
		t.Fatalf("plain errors must not gain errParams: %#v", m)
	}
}

func TestWithUIErrNilDoesNotAddErr(t *testing.T) {
	m := withUIErr(map[string]any{"type": "pool"}, nil)
	if _, ok := m["err"]; ok {
		t.Fatalf("nil error must not add an err field: %#v", m)
	}
}
