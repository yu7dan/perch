package agent

import "testing"

func TestAgyResumeArgs(t *testing.T) {
	d := AgyDef()
	cases := []struct {
		intent ResumeIntent
		want   []string
	}{
		{ResumeIntent{Kind: "exact", ID: "abc"}, []string{"--conversation", "abc"}},
		{ResumeIntent{Kind: "exact"}, []string{"--continue"}},
		{ResumeIntent{Kind: "latest"}, []string{"--continue"}},
		{ResumeIntent{Kind: "new"}, nil},
	}
	for _, c := range cases {
		got := d.Args(c.intent, "")
		if len(got) != len(c.want) {
			t.Fatalf("%+v → %v, want %v", c.intent, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%+v → %v, want %v", c.intent, got, c.want)
			}
		}
	}
}

func TestCursorResumeArgs(t *testing.T) {
	d := CursorDef()
	cases := []struct {
		intent ResumeIntent
		want   []string
	}{
		{ResumeIntent{Kind: "exact", ID: "chat-1"}, []string{"--resume", "chat-1"}},
		{ResumeIntent{Kind: "exact"}, []string{"--continue"}},
		{ResumeIntent{Kind: "latest"}, []string{"--continue"}},
		{ResumeIntent{Kind: "new"}, nil},
	}
	for _, c := range cases {
		got := d.Args(c.intent, "")
		if len(got) != len(c.want) {
			t.Fatalf("%+v → %v, want %v", c.intent, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%+v → %v, want %v", c.intent, got, c.want)
			}
		}
	}
}
