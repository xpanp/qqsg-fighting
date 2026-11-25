package processing

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Opponent struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}
type Row struct {
	Name      string     `json:"name"`
	Faction   string     `json:"faction"`
	Count     int        `json:"count"`
	Opponents []Opponent `json:"opponents"`
}
type KD struct {
	Name    string   `json:"name"`
	Faction string   `json:"faction"`
	Kills   int      `json:"kills"`
	Deaths  int      `json:"deaths"`
	Ratio   *float64 `json:"ratio"`
}
type Overview struct {
	AKills   int     `json:"aKills"`
	BKills   int     `json:"bKills"`
	APlayers int     `json:"aPlayers"`
	BPlayers int     `json:"bPlayers"`
	AShare   float64 `json:"aShare"`
	BShare   float64 `json:"bShare"`
	Ratio    string  `json:"ratio"`
}
type Advantage struct {
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
	AKills  int   `json:"aKills"`
	BKills  int   `json:"bKills"`
	Net     int   `json:"net"`
}
type Stats struct {
	StartMs           int64    `json:"startMs"`
	EndMs             int64    `json:"endMs"`
	ProjectionVersion int64    `json:"projectionVersion"`
	Overview          Overview `json:"overview"`
	Kills             []Row    `json:"kills"`
	Deaths            []Row    `json:"deaths"`
	KDA               []KD     `json:"kda"`
	Advantages        struct {
		A Advantage `json:"a"`
		B Advantage `json:"b"`
	} `json:"advantages"`
}

func CountedAB(e model.Event) bool {
	return e.Status == "counted" && ((e.KillerFaction == "A" && e.VictimFaction == "B") || (e.KillerFaction == "B" && e.VictimFaction == "A"))
}
func Compute(events []model.Event, start, end, version int64) Stats {
	s := Stats{StartMs: start, EndMs: end, ProjectionVersion: version, Kills: []Row{}, Deaths: []Row{}, KDA: []KD{}}
	k, d := map[string]map[string]int{}, map[string]map[string]int{}
	f := map[string]string{}
	players := map[string]map[string]bool{"A": {}, "B": {}}
	valid := []model.Event{}
	for _, e := range events {
		if !CountedAB(e) || e.OccurredAtMs < start || e.OccurredAtMs >= end {
			continue
		}
		valid = append(valid, e)
		if e.KillerFaction == "A" {
			s.Overview.AKills++
		} else {
			s.Overview.BKills++
		}
		players[e.KillerFaction][e.Killer] = true
		players[e.VictimFaction][e.Victim] = true
		f[e.Killer] = e.KillerFaction
		f[e.Victim] = e.VictimFaction
		if k[e.Killer] == nil {
			k[e.Killer] = map[string]int{}
		}
		if d[e.Victim] == nil {
			d[e.Victim] = map[string]int{}
		}
		k[e.Killer][e.Victim]++
		d[e.Victim][e.Killer]++
	}
	s.Overview.APlayers = len(players["A"])
	s.Overview.BPlayers = len(players["B"])
	total := s.Overview.AKills + s.Overview.BKills
	if total > 0 {
		s.Overview.AShare = float64(s.Overview.AKills) / float64(total)
		s.Overview.BShare = float64(s.Overview.BKills) / float64(total)
	}
	s.Overview.Ratio = fmt.Sprintf("%d:%d", s.Overview.AKills, s.Overview.BKills)
	rows := func(m map[string]map[string]int) []Row {
		a := []Row{}
		for name, op := range m {
			row := Row{Name: name, Faction: f[name], Opponents: []Opponent{}}
			for n, c := range op {
				row.Count += c
				row.Opponents = append(row.Opponents, Opponent{n, c})
			}
			sort.Slice(row.Opponents, func(i, j int) bool {
				if row.Opponents[i].Count == row.Opponents[j].Count {
					return row.Opponents[i].Name < row.Opponents[j].Name
				}
				return row.Opponents[i].Count > row.Opponents[j].Count
			})
			a = append(a, row)
		}
		sort.Slice(a, func(i, j int) bool {
			if a[i].Count == a[j].Count {
				return a[i].Name < a[j].Name
			}
			return a[i].Count > a[j].Count
		})
		return a
	}
	s.Kills = rows(k)
	s.Deaths = rows(d)
	for name, faction := range f {
		row := KD{Name: name, Faction: faction}
		for _, c := range k[name] {
			row.Kills += c
		}
		for _, c := range d[name] {
			row.Deaths += c
		}
		if row.Deaths > 0 {
			v := float64(row.Kills) / float64(row.Deaths)
			row.Ratio = &v
		}
		s.KDA = append(s.KDA, row)
	}
	sort.Slice(s.KDA, func(i, j int) bool {
		a, b := s.KDA[i], s.KDA[j]
		if a.Kills == b.Kills {
			if a.Deaths == b.Deaths {
				return a.Name < b.Name
			}
			return a.Deaths < b.Deaths
		}
		return a.Kills > b.Kills
	})
	sort.Slice(valid, func(i, j int) bool { return valid[i].OccurredAtMs < valid[j].OccurredAtMs })
	s.Advantages.A, s.Advantages.B = bestWindows(valid, start, end)
	return s
}

// Max/min net in a half-open 10 minute window, earliest start breaks ties.
// Candidate boundaries also include just after an event leaves the left edge.
func bestWindows(a []model.Event, start, end int64) (Advantage, Advantage) {
	duration := min(int64(600000), end-start)
	if duration < 0 {
		duration = 0
	}
	candidates := []int64{start}
	for _, e := range a {
		for _, x := range []int64{e.OccurredAtMs, e.OccurredAtMs + 1, e.OccurredAtMs - duration + 1} {
			if x >= start && x+duration <= end {
				candidates = append(candidates, x)
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i] < candidates[j] })
	prefix := make([]int, len(a)+1)
	for i, e := range a {
		prefix[i+1] = prefix[i]
		if e.KillerFaction == "A" {
			prefix[i+1]++
		}
	}
	first := true
	var bestA, bestB Advantage
	for _, x := range candidates {
		l := sort.Search(len(a), func(i int) bool { return a[i].OccurredAtMs >= x })
		r := sort.Search(len(a), func(i int) bool { return a[i].OccurredAtMs >= x+duration })
		ak := prefix[r] - prefix[l]
		bk := r - l - ak
		w := Advantage{StartMs: x, EndMs: x + duration, AKills: ak, BKills: bk, Net: ak - bk}
		if first || w.Net > bestA.Net {
			bestA = w
		}
		if first || w.Net < bestB.Net {
			bestB = w
		}
		first = false
	}
	return bestA, bestB
}
func Excel(s Stats, events []model.Event) ([]byte, error) {
	overview := [][]string{{"范围开始(UTC)", "范围结束(UTC)", "A击杀", "B击杀", "A参战人数", "B参战人数", "A人头占比", "B人头占比", "比分", "结果版本"}, {stamp(s.StartMs), stamp(s.EndMs), num(s.Overview.AKills), num(s.Overview.BKills), num(s.Overview.APlayers), num(s.Overview.BPlayers), fmt.Sprintf("%.2f%%", 100*s.Overview.AShare), fmt.Sprintf("%.2f%%", 100*s.Overview.BShare), s.Overview.Ratio, fmt.Sprint(s.ProjectionVersion)}}
	kill, death := [][]string{{"人名", "阵营", "击杀次数", "击杀对象及次数"}}, [][]string{{"人名", "阵营", "死亡次数", "击杀者及次数"}}
	for _, r := range s.Kills {
		kill = append(kill, []string{r.Name, r.Faction, num(r.Count), opponentText(r.Opponents)})
	}
	for _, r := range s.Deaths {
		death = append(death, []string{r.Name, r.Faction, num(r.Count), opponentText(r.Opponents)})
	}
	kd := [][]string{{"人名", "阵营", "击杀", "死亡", "K/D"}}
	for _, r := range s.KDA {
		ratio := "无死亡"
		if r.Ratio != nil {
			ratio = fmt.Sprintf("%.3f", *r.Ratio)
		}
		kd = append(kd, []string{r.Name, r.Faction, num(r.Kills), num(r.Deaths), ratio})
	}
	advantage := [][]string{{"优势方", "开始UTC", "结束UTC", "A击杀", "B击杀", "A-B净差"}}
	for i, w := range []Advantage{s.Advantages.A, s.Advantages.B} {
		advantage = append(advantage, []string{[]string{"A", "B"}[i], stamp(w.StartMs), stamp(w.EndMs), num(w.AKills), num(w.BKills), num(w.Net)})
	}
	detail := [][]string{{"事件ID", "时间UTC", "击杀者", "阵营", "被击杀者", "阵营", "状态", "原因", "来源数", "原文", "配置版本"}}
	for _, e := range events {
		detail = append(detail, []string{e.ID, stamp(e.OccurredAtMs), e.Killer, e.KillerFaction, e.Victim, e.VictimFaction, e.Status, e.Reason, num(e.SourceCount), e.Text, e.ConfigVersion})
	}
	return workbook([]string{"概览", "击杀", "死亡", "KD", "阵营优势", "事件数据"}, [][][]string{overview, kill, death, kd, advantage, detail})
}
func stamp(ms int64) string { return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano) }
func num(n int) string      { return strconv.Itoa(n) }
func opponentText(a []Opponent) string {
	s := ""
	for i, o := range a {
		if i > 0 {
			s += "、"
		}
		s += fmt.Sprintf("%s × %d", o.Name, o.Count)
	}
	return s
}
func escaped(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func workbook(names []string, sheets [][][]string) ([]byte, error) {
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	write := func(name, s string) error {
		w, e := z.Create(name)
		if e != nil {
			return e
		}
		_, e = w.Write([]byte(s))
		return e
	}
	types := `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
	wb := `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
	rels := `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
	for i, name := range names {
		id := strconv.Itoa(i + 1)
		types += `<Override PartName="/xl/worksheets/sheet` + id + `.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
		wb += `<sheet name="` + escaped(name) + `" sheetId="` + id + `" r:id="rId` + id + `"/>`
		rels += `<Relationship Id="rId` + id + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet` + id + `.xml"/>`
		var sheet strings.Builder
		sheet.Grow(len(sheets[i])*180)
		sheet.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
		for r, row := range sheets[i] {
			sheet.WriteString(`<row r="` + strconv.Itoa(r+1) + `">`)
			for _, v := range row {
				sheet.WriteString(`<c t="inlineStr"><is><t xml:space="preserve">`)
				if err:=xml.EscapeText(&sheet,[]byte(v));err!=nil{return nil,err}
				sheet.WriteString(`</t></is></c>`)
			}
			sheet.WriteString(`</row>`)
		}
		sheet.WriteString(`</sheetData></worksheet>`)
		if e := write("xl/worksheets/sheet"+id+".xml", sheet.String()); e != nil {
			return nil, e
		}
	}
	for _, f := range []struct{ name, s string }{{"[Content_Types].xml", types + `</Types>`}, {"_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`}, {"xl/workbook.xml", wb + `</sheets></workbook>`}, {"xl/_rels/workbook.xml.rels", rels + `</Relationships>`}} {
		if e := write(f.name, f.s); e != nil {
			return nil, e
		}
	}
	if e := z.Close(); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}
