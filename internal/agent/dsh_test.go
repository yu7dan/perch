package agent

import (
	"reflect"
	"testing"
)

func TestDshArgs(t *testing.T) {
	cases := []struct {
		name string
		in   ResumeIntent
		want []string
	}{
		{"new", ResumeIntent{Kind: "new"}, []string{"."}},
		{"latest", ResumeIntent{Kind: "latest"}, []string{"--resume"}},
		{"exact", ResumeIntent{Kind: "exact", ID: "9c34b2f4"}, []string{"--resume", "9c34b2f4"}},
		{"exact-empty", ResumeIntent{Kind: "exact"}, []string{"."}},
		{"fork-unsupported", ResumeIntent{Kind: "fork", ID: "x"}, []string{"."}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := dshArgs(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("dshArgs(%+v) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}
