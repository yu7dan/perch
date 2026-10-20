package stream

import (
	"strings"
	"testing"
)

func TestRedactLogSecrets(t *testing.T) {
	cases := []struct {
		in, secret string
	}{
		{"dsh web: http://127.0.0.1:3080/?token=TOK123&x=1", "TOK123"},
		{"Authorization: Bearer BEARER456", "BEARER456"},
		{"provider key sk-abcdefgh12345678 ok", "sk-abcdefgh12345678"},
	}
	for _, c := range cases {
		out := redactLogSecrets(c.in)
		if strings.Contains(out, c.secret) {
			t.Fatalf("secret 没被抹掉: in=%q out=%q", c.in, out)
		}
	}
	if !strings.Contains(redactLogSecrets("plain text"), "plain text") {
		t.Fatal("普通文本被改坏了")
	}
}
