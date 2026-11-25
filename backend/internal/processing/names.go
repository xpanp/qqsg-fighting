package processing

import (
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"strings"
	"unicode"
)

// MatchKey is used only for matching. Display names and source evidence are preserved.
func MatchKey(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, s)
}

type NameResolver struct {
	exact    map[string]string
	keys     map[string][]string
	factions map[string]string
	blocked  map[string]bool
	names    []string
	cache    map[string]resolution
}
type resolution struct {
	name, faction string
	uncertain     bool
}

func NewResolver(c model.NameConfig) (*NameResolver, error) {
	r := &NameResolver{exact: map[string]string{}, keys: map[string][]string{}, factions: map[string]string{}, blocked: map[string]bool{}, cache: map[string]resolution{}}
	for _, group := range []struct {
		names   []string
		faction string
	}{{c.NameA, "A"}, {c.NameB, "B"}, {c.NameOthers, "others"}} {
		for _, name := range group.names {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if faction, ok := r.factions[name]; ok {
				if faction == group.faction {
					continue
				}
				return nil, fmt.Errorf("conflicting faction for standard name: %s", name)
			}
			if len([]rune(name)) > 40 {
				return nil, fmt.Errorf("name too long")
			}
			r.factions[name] = group.faction
			r.exact[name] = name
			r.names = append(r.names, name)
			k := MatchKey(name)
			r.keys[k] = append(r.keys[k], name)
		}
	}
	for _, a := range c.Aliases {
		a.Alias = strings.TrimSpace(a.Alias)
		if _, ok := r.factions[a.Canonical]; !ok {
			return nil, fmt.Errorf("alias canonical is not a standard name: %s", a.Canonical)
		}
		if a.Alias == "" {
			return nil, fmt.Errorf("empty alias")
		}
		if old, ok := r.exact[a.Alias]; ok && old != a.Canonical {
			return nil, fmt.Errorf("conflicting alias: %s", a.Alias)
		}
		r.exact[a.Alias] = a.Canonical
		k := MatchKey(a.Alias)
		if !contains(r.keys[k], a.Canonical) {
			r.keys[k] = append(r.keys[k], a.Canonical)
		}
	}
	for _, n := range c.Blacklist {
		if n = strings.TrimSpace(n); n != "" {
			r.blocked[n] = true
			if canonical, ok := r.exact[n]; ok {
				r.blocked[canonical] = true
			}
		}
	}
	return r, nil
}
func contains(a []string, s string) bool {
	for _, x := range a {
		if x == s {
			return true
		}
	}
	return false
}
func (r *NameResolver) Resolve(raw string) (name, faction string, uncertain bool) {
	raw = strings.TrimSpace(raw)
	if cached, ok := r.cache[raw]; ok {
		return cached.name, cached.faction, cached.uncertain
	}
	defer func() { r.cache[raw] = resolution{name, faction, uncertain} }()
	if n, ok := r.exact[raw]; ok {
		return n, r.factions[n], false
	}
	key := MatchKey(raw)
	if ns := r.keys[key]; key != "" && len(ns) == 1 {
		return ns[0], r.factions[ns[0]], false
	}
	// Reuse the previous Python pipeline's unique missing-character and visual
	// comparisons. These transform matching keys only, never the display names.
	if len([]rune(key)) >= 2 && !digitsOnly(key) {
		owners := map[string]bool{}
		for candidate, names := range r.keys {
			short, long := []rune(key), []rune(candidate)
			gap := len(long) - len(short)
			maximum := 2
			if len(long) <= 6 {
				maximum = 3
			}
			if gap < 1 || gap > maximum || float64(len(short))/float64(len(long)) < 0.4 || digitsOnly(candidate) || !subsequence(short, long) {
				continue
			}
			for _, n := range names {
				owners[n] = true
			}
		}
		if len(owners) == 1 {
			for n := range owners {
				return n, r.factions[n], false
			}
		}
	}
	if winner := r.ranked(key, false, 0.8, 0.15); winner != "" {
		return winner, r.factions[winner], false
	}
	if winner := r.ranked(visualKey(key), true, 0.72, 0.12); winner != "" {
		return winner, r.factions[winner], false
	}
	return raw, "others", true
}
func visualKey(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '0' {
			return 'o'
		}
		if strings.ContainsRune("丶丨灬乄丿罒丷乀彡乂", r) {
			return -1
		}
		return r
	}, s)
}
func digitsOnly(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}
func subsequence(short, long []rune) bool {
	i := 0
	for _, r := range long {
		if i < len(short) && short[i] == r {
			i++
		}
	}
	return i == len(short)
}
func (r *NameResolver) ranked(key string, visual bool, threshold, margin float64) string {
	minimum := 4
	if visual {
		minimum = 3
	}
	if len([]rune(key)) < minimum || digitsOnly(key) {
		return ""
	}
	scores := map[string]float64{}
	for candidate, names := range r.keys {
		if visual {
			candidate = visualKey(candidate)
		}
		if len([]rune(candidate)) < minimum || digitsOnly(candidate) {
			continue
		}
		score := similarity(key, candidate)
		for _, name := range names {
			if score > scores[name] {
				scores[name] = score
			}
		}
	}
	best, second := 0.0, 0.0
	winner := ""
	for name, score := range scores {
		if score > best {
			second = best
			best = score
			winner = name
		} else if score > second {
			second = score
		}
	}
	if best >= threshold && best-second >= margin {
		return winner
	}
	return ""
}
func (r *NameResolver) Blocked(raw, canonical string) bool {
	return r.blocked[raw] || r.blocked[canonical]
}
func similarity(a, b string) float64 {
	x, y := []rune(a), []rune(b)
	if len(x) == 0 || len(y) == 0 {
		return 0
	}
	prev := make([]int, len(y)+1)
	for j := range prev {
		prev[j] = j
	}
	for i, c := range x {
		cur := make([]int, len(y)+1)
		cur[0] = i + 1
		for j, d := range y {
			cost := 1
			if c == d {
				cost = 0
			}
			cur[j+1] = min(cur[j]+1, prev[j+1]+1, prev[j]+cost)
		}
		prev = cur
	}
	return 1 - float64(prev[len(y)])/float64(max(len(x), len(y)))
}
