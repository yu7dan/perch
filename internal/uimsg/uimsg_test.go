package uimsg

import (
	"errors"
	"fmt"
	"testing"
)

func TestFromFindsIdentityThroughWrapping(t *testing.T) {
	base := errors.New("disk says no")
	err := Wrap(base, "settings.saveFailed", "设置没写成：disk says no",
		map[string]string{"err": base.Error()})

	if !errors.Is(err, base) {
		t.Fatalf("Wrap must keep the cause reachable: %v", err)
	}
	if got, want := err.Error(), "设置没写成：disk says no"; got != want {
		t.Fatalf("Error() = %q, want %q", got, want)
	}

	msg, ok := From(fmt.Errorf("outer: %w", err))
	if !ok {
		t.Fatal("From must see through fmt.Errorf(%w)")
	}
	if msg.Code != "settings.saveFailed" {
		t.Fatalf("Code = %q", msg.Code)
	}
	if msg.Params["err"] != "disk says no" {
		t.Fatalf("Params = %#v", msg.Params)
	}
	if msg.Text != "设置没写成：disk says no" {
		t.Fatalf("Text = %q", msg.Text)
	}
}

func TestFromRejectsPlainErrors(t *testing.T) {
	if _, ok := From(errors.New("plain")); ok {
		t.Fatal("plain errors must not pretend to have a UI identity")
	}
	// nil is not an error and must not panic.
	if _, ok := From(nil); ok {
		t.Fatal("nil must not have an identity")
	}
}

func TestNewParams(t *testing.T) {
	err := NewParams("settings.unknownAgent", "不认识这个 agent：nope",
		map[string]string{"agent": "nope"})
	msg, ok := From(err)
	if !ok || msg.Code != "settings.unknownAgent" || msg.Params["agent"] != "nope" {
		t.Fatalf("got %#v (ok=%v)", msg, ok)
	}
}
