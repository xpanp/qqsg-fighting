package processing

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"io"
	"testing"
	"time"
)

func testConfig() model.NameConfig {
	return model.NameConfig{ID: "v1", NameA: []string{"Alpha", "别名苏"}, NameB: []string{"Beta"}, Aliases: []model.Alias{{Canonical: "别名苏", Alias: "x苏"}}}
}
func source(id, msg string, at int64) model.SourceMessage {
	return model.SourceMessage{SourceID: id, SessionID: "s", MessageID: msg, Revision: 1, Text: "[地图]Alpha在战斗中击败了Beta", GameTime: "08:00:10", EventAtMs: at, Context: model.Context{Realm: "realm", Line: "1", ClockUncertaintyMs: 100}}
}
func TestSameSourceOccurrenceNotAbsorbedViaAnotherSource(t *testing.T) {
	a := source("A", "1", 10000)
	b := source("B", "1", 10500)
	a2 := source("A", "2", 11000)
	a2.GameTime = "08:00:11" // A real second event has a distinct game clock.
	events := Build([]model.SourceMessage{a, b, a2}, testConfig(), nil)
	if len(events) != 2 || events[0].SourceCount != 2 || events[1].SourceCount != 1 {
		t.Fatalf("expected 2 events with 2/1 sources: %+v", events)
	}
}
func TestDistinctLocalIDsAtSameGameClockAreEvidenceOfOneKill(t *testing.T) {
	a, b := source("a", "first", 10000), source("a", "ocr-again", 10000)
	events := Build([]model.SourceMessage{a, b}, testConfig(), nil)
	if len(events) != 1 || events[0].SourceCount != 1 || len(events[0].Members) != 2 {
		t.Fatal("same timestamp/pair was counted twice", events)
	}
	b.Text = "[地图]Beta在战斗中击败了Alpha"
	events = Build([]model.SourceMessage{a, b}, testConfig(), nil)
	if len(events) != 2 {
		t.Fatal("different kill pairs in same second collapsed", events)
	}
}
func TestLateSourceKeepsCanonicalAndOverride(t *testing.T) {
	a := source("Z", "1", 10500)
	b := source("A", "1", 10000)
	id := "persistent"
	ovs := map[string]model.Override{id: {EventID: id, Status: "excluded", Reason: "manual"}}
	ids := map[string]string{sourceKey(a): id}
	events := BuildWithIdentity([]model.SourceMessage{a, b}, testConfig(), ovs, ids)
	if len(events) != 1 || events[0].ID != id || events[0].SourceCount != 2 || events[0].Status != "excluded" {
		t.Fatalf("late evidence must preserve the canonical exclusion, not create another counted event: %+v", events)
	}
	for _, ev := range events {
		if ev.ID == id && ev.Status != "excluded" {
			t.Fatal("override lost")
		}
	}
	// Unchanged counted override retains membership and the stable identity.
	ovs[id] = model.Override{EventID: id, Status: "counted", Reason: "confirmed"}
	ids[sourceKey(b)] = id
	events = BuildWithIdentity([]model.SourceMessage{a, b}, testConfig(), ovs, ids)
	if len(events) != 1 || events[0].ID != id || events[0].SourceCount != 2 {
		t.Fatalf("existing membership duplicated: %+v", events)
	}
}
func TestSplitKeepsSourceEvidence(t *testing.T) {
	a, b := source("A", "1", 10000), source("B", "1", 10000)
	id := "stable"
	events := BuildWithIdentity([]model.SourceMessage{a, b}, testConfig(), map[string]model.Override{id: {EventID: id, Split: true, Reason: "separate"}}, map[string]string{sourceKey(a): id, sourceKey(b): id})
	if len(events) != 2 || events[0].ID == events[1].ID {
		t.Fatalf("split IDs: %+v", events)
	}
}
func TestChannelAndPollutionBoundaries(t *testing.T) {
	k, v, r := Parse("[地 图][14:00:01]Alpha在战斗中击败了Beta[大喇叭]买东西")
	if k != "Alpha" || v != "Beta" || r != "" {
		t.Fatal(k, v, r)
	}
	_, _, r = Parse("[同 屏]Alpha在战斗中击败了Beta")
	if r != "not_map_channel" {
		t.Fatal(r)
	}
	_, _, r = Parse("[地图]Alpha在战斗中击败了Beta大叭]买东西")
	if r != "trailing_channel_pollution" {
		t.Fatal(r)
	}
}
func TestGameClockBeforeObservationAndMidnight(t *testing.T) {
	if GameTime("[地图][33:99:88]invalid", "25:00:00") != "" {
		t.Fatal("invalid game clock accepted")
	}
	observed := time.Date(2026, 11, 19, 17, 58, 0, 0, china)
	m := model.Message{Text: "[地图][14:10:15]Alpha在战斗中击败了Beta", FirstObservedAtMs: observed.UnixMilli()}
	at := time.UnixMilli(EventTime(m, model.Context{})).In(china)
	if at.Hour() != 14 || at.Minute() != 10 || at.Day() != 19 {
		t.Fatal(at)
	}
	m.FirstObservedAtMs = time.Date(2026, 11, 20, 0, 0, 10, 0, china).UnixMilli()
	m.GameTime = "23:59:59"
	at = time.UnixMilli(EventTime(m, model.Context{})).In(china)
	if at.Day() != 19 || at.Hour() != 23 {
		t.Fatal(at)
	}
}
func TestObservedOnlyDoesNotInventTimePrecisionOrCrossSourceIdentity(t *testing.T) {
	a, b := source("a", "1", 10000), source("b", "1", 10001)
	a.GameTime = ""
	b.GameTime = ""
	events := Build([]model.SourceMessage{a, b}, testConfig(), nil)
	if len(events) != 2 {
		t.Fatal("observation proximity merged old chat", events)
	}
	for _, event := range events {
		if event.TimeQuality != "observed_only" || event.EventTimeUncertaintyMs != nil {
			t.Fatal("invented event time precision", event)
		}
	}
}
func TestNamesConservativeAndBlacklist(t *testing.T) {
	c := testConfig()
	c.Blacklist = []string{"x苏"}
	r, e := NewResolver(c)
	if e != nil {
		t.Fatal(e)
	}
	name, f, uncertain := r.Resolve("x苏")
	if name != "别名苏" || f != "A" || uncertain || !r.Blocked("x苏", name) {
		t.Fatal(name, f, uncertain)
	}
	_, _, uncertain = r.Resolve("苏")
	if !uncertain {
		t.Fatal("single character forced match")
	}
	c.Aliases = append(c.Aliases, model.Alias{Canonical: "Beta", Alias: "x苏"})
	if _, e = NewResolver(c); e == nil {
		t.Fatal("conflicting alias accepted")
	}
}
func TestStatABAndEarliestWindow(t *testing.T) {
	events := []model.Event{{ID: "b", OccurredAtMs: 0, Killer: "Beta", Victim: "Alpha", KillerFaction: "B", VictimFaction: "A", Status: "counted"}, {ID: "a", OccurredAtMs: 100, Killer: "Alpha", Victim: "Beta", KillerFaction: "A", VictimFaction: "B", Status: "counted"}, {ID: "other", OccurredAtMs: 200, Killer: "Alpha", Victim: "unknown", KillerFaction: "A", VictimFaction: "others", Status: "counted"}}
	s := Compute(events, 0, 1000000, 3)
	if s.Overview.AKills != 1 || s.Overview.BKills != 1 || s.Advantages.A.StartMs != 1 || s.Advantages.A.Net != 1 {
		t.Fatalf("stats %+v", s)
	}
	if s.Overview.AShare != 0.5 || len(s.KDA) != 2 {
		t.Fatal(s)
	}
	b, e := Excel(s, events)
	if e != nil {
		t.Fatal(e)
	}
	z, e := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if e != nil {
		t.Fatal(e)
	}
	for _, f := range z.File {
		r, e := f.Open()
		if e != nil {
			t.Fatal(e)
		}
		dec := xml.NewDecoder(r)
		for {
			_, e = dec.Token()
			if e == io.EOF {
				break
			}
			if e != nil {
				t.Fatalf("xlsx XML %s: %v", f.Name, e)
			}
		}
		r.Close()
	}
}
