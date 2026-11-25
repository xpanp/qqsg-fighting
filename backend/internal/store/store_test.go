package store

import (
	"context"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"testing"
	"time"
)

func setup(t *testing.T) *Store {
	t.Helper()
	s, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = s.Close() })
	_, _, e = s.SaveConfig(model.NameConfig{NameA: []string{"Alpha"}, NameB: []string{"Beta"}})
	if e != nil {
		t.Fatal(e)
	}
	drain(t, s)
	return s
}
func drain(t *testing.T, s *Store) {
	t.Helper()
	for i := 0; i < 100; i++ {
		worked, e := s.ProcessOne(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		if !worked {
			return
		}
	}
	t.Fatal("jobs never drained")
}
func batch(source, id string, at int64) model.Batch {
	game := time.UnixMilli(at / 2000 * 2000).In(time.FixedZone("China", 8*3600)).Format("15:04:05")
	return model.Batch{SchemaVersion: 2, BatchID: ID(), SourceID: source, SessionID: "session", Context: model.Context{Realm: "realm", Line: "1", SessionStartedAtMs: 10000, ClockUncertaintyMs: 100}, Messages: []model.Message{{ID: id, SessionID: "session", Text: "[地图]Alpha在战斗中击败了Beta", GameTime: game, Revision: 1, FirstObservedAtMs: at, LastObservedAtMs: at, Observations: 1}}}
}
func TestRevisionIdempotencyAndMutableEvidence(t *testing.T) {
	s := setup(t)
	b := batch("a", "one", 10000)
	ack, e := s.Ingest(b)
	if e != nil || len(ack.Accepted) != 1 {
		t.Fatal(ack, e)
	}
	b.Messages[0].LastObservedAtMs++
	b.Messages[0].Observations++
	ack, e = s.Ingest(b)
	if e != nil || len(ack.Accepted) != 1 {
		t.Fatal("mutable evidence conflict", ack, e)
	}
	b.Messages[0].Text = "[地图]Beta在战斗中击败了Alpha"
	ack, e = s.Ingest(b)
	if e != nil || len(ack.Rejected) != 1 || ack.Rejected[0].Code != "revision_conflict" {
		t.Fatal(ack, e)
	}
	b.Messages[0].Revision = 2
	_, e = s.Ingest(b)
	if e != nil {
		t.Fatal(e)
	}
	drain(t, s)
	events, _, e := s.Events(0, 100000)
	if e != nil || len(events) != 1 || events[0].Killer != "Beta" {
		t.Fatal(events, e)
	}
	b.Messages[0].Revision = 1
	b.Messages[0].Text = "[地图]Alpha在战斗中击败了Beta"
	_, e = s.Ingest(b)
	if e != nil {
		t.Fatal(e)
	}
	drain(t, s)
	events, _, _ = s.Events(0, 100000)
	if events[0].Killer != "Beta" {
		t.Fatal("old revision replaced latest")
	}
}
func TestConfigPublicationCannotMixPartialJobs(t *testing.T) {
	s := setup(t)
	for _, at := range []int64{10000, 1000000} {
		_, e := s.Ingest(batch("a", ID(), at))
		if e != nil {
			t.Fatal(e)
		}
	}
	drain(t, s)
	_, e := s.Ingest(batch("b", "late", 10000))
	if e != nil {
		t.Fatal(e)
	}
	newID, _, e := s.SaveConfig(model.NameConfig{NameA: []string{"Beta"}, NameB: []string{"Alpha"}})
	if e != nil {
		t.Fatal(e)
	}
	worked, e := s.ProcessOne(context.Background())
	if e != nil || !worked {
		t.Fatal(e)
	}
	events, _, e := s.Events(0, 2000000)
	if e != nil || len(events) != 2 {
		t.Fatal(events, e)
	}
	for _, ev := range events {
		if ev.ConfigVersion != newID || ev.KillerFaction != "B" {
			t.Fatalf("mixed projection %+v", events)
		}
	}
}
func TestMembershipStableThroughLateSourceAndAdminPatch(t *testing.T) {
	s := setup(t)
	_, _ = s.Ingest(batch("z", "one", 11000))
	drain(t, s)
	events, _, _ := s.Events(0, 100000)
	id := events[0].ID
	_, _ = s.Ingest(batch("a", "one", 10000))
	drain(t, s)
	events, _, _ = s.Events(0, 100000)
	if len(events) != 1 || events[0].ID != id || events[0].SourceCount != 2 {
		t.Fatal("canonical changed", events)
	}
	_, e := s.SetOverride(model.Override{RequestID: "r1", EventID: id, Killer: "Alpha", Status: "counted", Reason: "confirm"})
	if e != nil {
		t.Fatal(e)
	}
	drain(t, s)
	events, _, _ = s.Events(0, 100000)
	if len(events) != 1 || events[0].SourceCount != 2 {
		t.Fatal("override duplicated membership", events)
	}
	_, e = s.SetOverride(model.Override{RequestID: "r2", EventID: id, Status: "excluded", Reason: "exclude"})
	if e != nil {
		t.Fatal(e)
	}
	drain(t, s)
	ev, _, ovs, e := s.Event(id)
	if e != nil || ev.Status != "excluded" || ev.Killer != "Alpha" || len(ovs) != 2 {
		t.Fatal(ev, ovs, e)
	}
	_, e = s.SetOverride(model.Override{RequestID: "r1", EventID: id, Killer: "Alpha", Status: "counted", Reason: "confirm"})
	if e != nil {
		t.Fatal("idempotent old patch replay", e)
	}
}
func TestPartialHaloDoesNotLoseBoundaryEvidence(t *testing.T) {
	s := setup(t)
	_, _ = s.Ingest(batch("a", "left", 10000))
	_, _ = s.Ingest(batch("b", "left", 11000))
	_, _ = s.Ingest(batch("a", "right", 22000))
	drain(t, s)
	b := batch("c", "touch", 16000)
	_, _ = s.Ingest(b)
	drain(t, s)
	events, _, e := s.Events(0, 100000)
	if e != nil {
		t.Fatal(e)
	}
	totalSources := 0
	for _, ev := range events {
		totalSources += ev.SourceCount
	}
	if len(events) != 3 || totalSources != 4 {
		t.Fatal("boundary evidence lost", events)
	}
}
