package processing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var channelRE = regexp.MustCompile(`[\[【]\s*(系\s*统|同\s*屏|队\s*伍|密\s*语|职\s*业|国\s*家|小\s*喇\s*叭|大\s*喇\s*叭|地\s*图|军\s*团|好\s*友|阵\s*营)\s*[\]】]`)
var gameRE = regexp.MustCompile(`[\[【]\s*(\d{2})\s*[:：]\s*(\d{2})\s*[:：]\s*(\d{2})\s*[\]】]`)
var bareTimeRE = regexp.MustCompile(`^\d{2}:\d{2}:\d{2}$`)
var pollutionRE = regexp.MustCompile(`(?:大.{0,2}叭|大喇|大剩叭|小.{0,2}叭)[\]】]|(?:地图|图)[\]】]|在战斗中击败`)
var china = time.FixedZone("Asia/Shanghai", 8*3600)

const AlgorithmVersion = "p2-events-3"

func GameTime(text, provided string) string {
	if bareTimeRE.MatchString(provided) {
		if _, err := time.Parse("15:04:05", provided); err == nil {
			return provided
		}
	}
	m := gameRE.FindStringSubmatch(text)
	if len(m) > 0 {
		value := strings.Join(m[1:], ":")
		if _, err := time.Parse("15:04:05", value); err == nil {
			return value
		}
	}
	return ""
}

// The in-game wall clock may predate observation by hours when chat stops scrolling.
func EventTime(m model.Message, c model.Context) int64 {
	observed := m.FirstObservedAtMs + int64(c.ClockOffsetMs)
	g := GameTime(m.Text, m.GameTime)
	if g == "" {
		return observed
	}
	t, err := time.ParseInLocation("15:04:05", g, china)
	if err != nil {
		return observed
	}
	d := time.UnixMilli(observed).In(china)
	candidate := time.Date(d.Year(), d.Month(), d.Day(), t.Hour(), t.Minute(), t.Second(), 0, china)
	// Prefer latest occurrence not later than observation (small clock skew allowed), including midnight.
	if candidate.UnixMilli() > observed+120000 {
		candidate = candidate.AddDate(0, 0, -1)
	}
	return candidate.UnixMilli()
}
func Parse(text string) (killer, victim, reason string) {
	locs := channelRE.FindAllStringSubmatchIndex(text, -1)
	if len(locs) == 0 {
		return "", "", "missing_channel"
	}
	for i, loc := range locs {
		ch := strings.Join(strings.Fields(text[loc[2]:loc[3]]), "")
		if ch != "地图" {
			continue
		}
		end := len(text)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		body := text[loc[1]:end]
		body = gameRE.ReplaceAllString(body, "")
		body = strings.ReplaceAll(strings.ReplaceAll(body, "\n", ""), "\r", "")
		parts := strings.Split(body, "在战斗中击败了")
		if len(parts) != 2 {
			return "", "", "incomplete_or_joined_battle"
		}
		killer = strings.TrimSpace(parts[0])
		victim = strings.TrimSpace(parts[1])
		if pollutionRE.MatchString(victim) || strings.ContainsAny(victim, "[【") {
			return killer, victim, "trailing_channel_pollution"
		}
		if killer == "" || victim == "" || utf8.RuneCountInString(killer) > 20 || utf8.RuneCountInString(victim) > 20 {
			return killer, victim, "invalid_name_length"
		}
		return killer, victim, ""
	}
	return "", "", "not_map_channel"
}
func StableID(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(h[:12])
}
func sourceKey(s model.SourceMessage) string {
	return s.SourceID + "\x00" + s.SessionID + "\x00" + s.MessageID
}
func Build(sources []model.SourceMessage, c model.NameConfig, overrides map[string]model.Override) []model.Event {
	return BuildWithIdentity(sources, c, overrides, nil)
}
func BuildWithIdentity(sources []model.SourceMessage, c model.NameConfig, overrides map[string]model.Override, identities map[string]string) []model.Event {
	events, _ := BuildWithIdentityContext(context.Background(), sources, c, overrides, identities)
	return events
}
func BuildWithIdentityContext(ctx context.Context, sources []model.SourceMessage, c model.NameConfig, overrides map[string]model.Override, identities map[string]string) ([]model.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r, err := NewResolver(c)
	if err != nil {
		return nil, err
	}
	sort.Slice(sources, func(i, j int) bool {
		ki, kj := identities[sourceKey(sources[i])] != "", identities[sourceKey(sources[j])] != ""
		if ki != kj {
			return ki
		}
		if sources[i].EventAtMs == sources[j].EventAtMs {
			return sourceKey(sources[i]) < sourceKey(sources[j])
		}
		return sources[i].EventAtMs < sources[j].EventAtMs
	})
	events := []model.Event{}
	for _, s := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		rawK, rawV, reason := Parse(s.Text)
		if reason == "not_map_channel" {
			continue
		}
		k, kf, ku := r.Resolve(rawK)
		v, vf, vu := r.Resolve(rawV)
		status := "counted"
		if reason != "" {
			status = "excluded"
		} else if r.Blocked(rawK, k) || r.Blocked(rawV, v) {
			status = "excluded"
			reason = "blacklisted"
		} else if ku || vu {
			status = "pending"
			reason = "unresolved_name"
		} else if k == v {
			status = "pending"
			reason = "name_identity_conflict"
		}
		id := StableID(s.SourceID, s.SessionID, s.MessageID)
		if prior := identities[sourceKey(s)]; prior != "" {
			id = prior
		}
		ov, hasOverride := overrides[id]
		match := -1
		// Retain existing membership (and its admin override) across recomputation.
		if !ov.Split {
			for i := range events {
				e := events[i]
				if e.ID == id && identities[sourceKey(s)] == id && ((e.Killer == k && e.Victim == v) || hasOverride) && e.Sources[0].GameTime == s.GameTime {
					match = i
					break
				}
			}
		}
		if match < 0 && !hasOverride && !ku && !vu && s.Context.Realm != "" && s.Context.Line != "" {
			for i := len(events) - 1; i >= 0; i-- {
				if i%128 == 0 {
					if err := ctx.Err(); err != nil {
						return nil, err
					}
				}
				e := events[i]
				delta := s.EventAtMs - e.OccurredAtMs
				if delta < -2000 || delta > 2000 {
					continue
				}
				protected, isProtected := overrides[e.ID]
				if isProtected && protected.Split {
					continue
				}
				for _, p := range e.Sources {
					// First observation is not the event time of stationary old chat.
					if p.GameTime == "" || s.GameTime == "" {
						continue
					}
					if p.Context.Realm != s.Context.Realm || p.Context.Line != s.Context.Line {
						continue
					}
					if p.Context.ClockUncertaintyMs > 1500 || s.Context.ClockUncertaintyMs > 1500 {
						continue
					}
					if (p.GameTime == "") != (s.GameTime == "") {
						continue
					}
					if p.GameTime != "" && p.GameTime != s.GameTime {
						continue
					}
					namesMatch := e.Killer == k && e.Victim == v
					if isProtected {
						pk, pv, pr := Parse(p.Text)
						pk, _, _ = r.Resolve(pk)
						pv, _, _ = r.Resolve(pv)
						namesMatch = namesMatch || (pr == "" && pk == k && pv == v)
					}
					if !namesMatch || (!isProtected && e.Status != status) {
						continue
					}
					match = i
					break
				}
				if match >= 0 {
					break
				}
			}
		}
		if match >= 0 {
			e := &events[match]
			e.Sources = append(e.Sources, s)
			e.Members = append(e.Members, s)
			if !contains(e.SourceIDs, s.SourceID) {
				e.SourceIDs = append(e.SourceIDs, s.SourceID)
			}
			e.SourceCount = len(e.SourceIDs)
			continue
		}
		// On explicit split, keep the old anchor for the first member and give others source-stable identities.
		for _, prior := range events {
			if prior.ID == id {
				id = StableID(s.SourceID, s.SessionID, s.MessageID)
				break
			}
		}
		e := model.Event{ID: id, OccurredAtMs: s.EventAtMs, Text: s.Text, Killer: k, Victim: v, KillerFaction: kf, VictimFaction: vf, Status: status, Reason: reason, SourceCount: 1, SourceIDs: []string{s.SourceID}, ConfigVersion: c.ID, Sources: []model.SourceMessage{s}, Members: []model.SourceMessage{s}}
		e.TimeQuality = "observed_only"
		e.AlgorithmVersion = AlgorithmVersion
		e.TimeReason = "no game clock; observed time is an approximation"
		e.EventTimeUncertaintyMs = nil // Unbounded message age; not the network clock error.
		if s.GameTime != "" {
			e.TimeQuality = "game_inferred"
			e.TimeReason = "game wall time dated from observation; midnight inference"
			uncertainty := 1000 + s.Context.ClockUncertaintyMs
			e.EventTimeUncertaintyMs = &uncertainty
		}
		if hasOverride {
			ApplyOverride(&e, ov, r)
		}
		events = append(events, e)
	}
	// Explicit merges are administrator decisions; preserve both evidence sets and exclude the duplicate.
	idx := map[string]int{}
	for i := range events {
		idx[events[i].ID] = i
	}
	for i := range events {
		ov, ok := overrides[events[i].ID]
		if !ok || ov.MergeInto == "" {
			continue
		}
		target := ov.MergeInto
		seen := map[string]bool{events[i].ID: true}
		for target != "" && !seen[target] {
			seen[target] = true
			next := overrides[target].MergeInto
			if next == "" {
				break
			}
			target = next
		}
		if j, exists := idx[target]; exists && i != j {
			events[j].Sources = append(events[j].Sources, events[i].Sources...)
			for _, sid := range events[i].SourceIDs {
				if !contains(events[j].SourceIDs, sid) {
					events[j].SourceIDs = append(events[j].SourceIDs, sid)
				}
			}
			events[j].SourceCount = len(events[j].SourceIDs)
			events[i].Status = "duplicate"
			events[i].Reason = "admin_merged"
		}
	}
	return events, nil
}
func ApplyOverride(e *model.Event, o model.Override, r *NameResolver) {
	if o.Killer != "" {
		e.Killer, e.KillerFaction, _ = r.Resolve(o.Killer)
	}
	if o.Victim != "" {
		e.Victim, e.VictimFaction, _ = r.Resolve(o.Victim)
	}
	if o.Status != "" {
		e.Status = o.Status
		e.Reason = "admin: " + o.Reason
	}
	if r.Blocked(e.Killer, e.Killer) || r.Blocked(e.Victim, e.Victim) {
		e.Status = "excluded"
		e.Reason = "blacklisted"
	}
}
