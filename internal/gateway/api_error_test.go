package gateway

import (
	"strings"
	"testing"

	"github.com/yu7dan/perch/internal/uimsg"
)

func TestAPIErrorKnownCodes(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		code   string
		params map[string]string
	}{
		{
			name:   "no models",
			body:   `{"code":"no_models","agent":"agy"}`,
			code:   "gw.noModels",
			params: map[string]string{"agent": "agy"},
		},
		{
			name:   "all hidden",
			body:   `{"code":"all_hidden","agent":"agy"}`,
			code:   "gw.allHidden",
			params: map[string]string{"agent": "agy"},
		},
		{
			name:   "runtime unavailable",
			body:   `{"code":"runtime_unavailable","agent":"agy","offline":"x"}`,
			code:   "gw.runtimeUnavailable",
			params: map[string]string{"agent": "agy", "offline": "x"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := apiError([]byte(tc.body), 409)
			msg, ok := uimsg.From(err)
			if !ok {
				t.Fatalf("error has no UI identity: %v", err)
			}
			if msg.Code != tc.code {
				t.Fatalf("code = %q, want %q", msg.Code, tc.code)
			}
			for k, want := range tc.params {
				if got := msg.Params[k]; got != want {
					t.Fatalf("param %s = %q, want %q", k, got, want)
				}
			}
		})
	}
}

func TestAPIErrorAgentNotConnectable(t *testing.T) {
	err := apiError([]byte(`{"error":"Cursor CLI can't be connected to magpie"}`), 400)
	msg, ok := uimsg.From(err)
	if !ok || msg.Code != "gw.agentNotConnectable" {
		t.Fatalf("code = %q ok=%v, want gw.agentNotConnectable", msg.Code, ok)
	}
}

func TestAPIErrorNoBodyNeverLeaksResponse(t *testing.T) {
	err := apiError([]byte(`<html>secret-token</html>`), 500)
	msg, ok := uimsg.From(err)
	if !ok || msg.Code != "gw.httpErrorNoBody" {
		t.Fatalf("code = %q ok=%v, want gw.httpErrorNoBody", msg.Code, ok)
	}
	if msg.Params["status"] != "500" {
		t.Fatalf("status = %q", msg.Params["status"])
	}
	if strings.Contains(msg.Text, "secret-token") || strings.Contains(msg.Text, "<html>") {
		t.Fatalf("raw response leaked into the message: %q", msg.Text)
	}
}

func TestAPIErrorGenericReason(t *testing.T) {
	err := apiError([]byte(`{"error":"bad request"}`), 400)
	msg, ok := uimsg.From(err)
	if !ok || msg.Code != "gw.httpError" {
		t.Fatalf("code = %q ok=%v, want gw.httpError", msg.Code, ok)
	}
	if msg.Params["reason"] != "bad request" || msg.Params["status"] != "400" {
		t.Fatalf("params = %#v", msg.Params)
	}
}
