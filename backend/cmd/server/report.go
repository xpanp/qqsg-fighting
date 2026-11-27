package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/xpanp/qqsg-fighting/backend/internal/model"
	"github.com/xpanp/qqsg-fighting/backend/internal/processing"
	"github.com/xpanp/qqsg-fighting/backend/internal/store"
)

func report(args []string) error {
	flags := flag.NewFlagSet("report", flag.ContinueOnError)
	input := flags.String("input", "", "merged OCR TXT or source-message JSON array")
	roster := flags.String("roster", "", "directory containing roster files")
	output := flags.String("output", "", "Excel output path")
	timezone := flags.String("timezone", "Asia/Shanghai", "observation timezone for TXT")
	self := flags.String("self-name", "", "character name for single-perspective TXT")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" || *roster == "" || *output == "" || flags.NArg() != 0 {
		return fmt.Errorf("report requires --input, --roster and --output")
	}
	config, err := store.ReadNameFiles(*roster)
	if err != nil {
		return err
	}
	if _, err := processing.NewResolver(config); err != nil {
		return err
	}
	configBytes, err := json.Marshal(config)
	if err != nil {
		return err
	}
	config.ID = processing.StableID(string(configBytes))
	loc, err := time.LoadLocation(*timezone)
	if err != nil {
		return err
	}
	sources, anomalies, err := readReportInput(*input, *self, loc)
	if err != nil {
		return err
	}
	events := processing.Build(sources, config, nil)
	var min, max int64
	for i, event := range events {
		if i == 0 || event.OccurredAtMs < min {
			min = event.OccurredAtMs
		}
		if event.OccurredAtMs > max {
			max = event.OccurredAtMs
		}
		if event.Status != "counted" {
			anomalies = append(anomalies, map[string]any{"file": *input, "eventId": event.ID, "sourceIds": event.SourceIDs, "messageIds": reportMessageIDs(event), "status": event.Status, "reason": event.Reason})
		}
	}
	stats := processing.Compute(events, min, max+1, 0)
	data, err := processing.Excel(stats, events)
	if err != nil {
		return err
	}
	summary, err := json.MarshalIndent(map[string]any{"configVersion": config.ID, "algorithmVersion": processing.AlgorithmVersion, "anomalies": anomalies, "stats": stats}, "", "  ")
	if err != nil {
		return err
	}
	if !strings.HasSuffix(strings.ToLower(*output), ".xlsx") {
		return fmt.Errorf("report output must end in .xlsx")
	}
	if err := writeNewReport(*output, data); err != nil {
		return err
	}
	if err := writeNewReport(*output+".json", summary); err != nil {
		_ = os.Remove(*output)
		return err
	}
	return nil
}

func writeNewReport(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(path)
	}
	return err
}
func readReportInput(path, self string, loc *time.Location) ([]model.SourceMessage, []map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	sources := []model.SourceMessage{}
	anomalies := []map[string]any{}
	if strings.HasSuffix(strings.ToLower(path), ".json") {
		err := json.NewDecoder(file).Decode(&sources)
		for _, s := range sources {
			if s.SourceID == "" || s.SessionID == "" || s.MessageID == "" || s.FirstObservedAtMs <= 0 || s.EventAtMs <= 0 {
				return nil, nil, fmt.Errorf("JSON source messages require source, session, message and timestamps")
			}
		}
		return sources, anomalies, err
	}
	sc := bufio.NewScanner(file)
	sc.Buffer(make([]byte, 4096), 1<<20)
	for line := 1; sc.Scan(); line++ {
		row := strings.TrimSpace(strings.TrimPrefix(sc.Text(), "\ufeff"))
		if row == "" {
			continue
		}
		stamp, body, ok := strings.Cut(row, "  ")
		ts, err := time.ParseInLocation("2006-01-02 15:04:05.999", stamp, loc)
		if !ok || err != nil {
			anomalies = append(anomalies, map[string]any{"file": path, "line": line, "status": "rejected", "reason": "invalid observation timestamp"})
			continue
		}
		body = strings.TrimSpace(body)
		if _, _, reason := processing.Parse(body); reason == "not_map_channel" || reason == "missing_channel" {
			anomalies = append(anomalies, map[string]any{"file": path, "line": line, "status": "ignored", "reason": reason})
			continue
		}
		m := model.Message{Text: body, FirstObservedAtMs: ts.UnixMilli()}
		c := model.Context{Realm: "得陇望蜀", Character: self}
		sources = append(sources, model.SourceMessage{SourceID: "offline", SessionID: "txt", MessageID: fmt.Sprint(line), Revision: 1, Text: body, FirstObservedAtMs: m.FirstObservedAtMs, LastObservedAtMs: m.FirstObservedAtMs, GameTime: processing.GameTime(body, ""), EventAtMs: processing.EventTime(m, c), Context: c})
	}
	return sources, anomalies, sc.Err()
}

func reportMessageIDs(event model.Event) []string {
	ids := make([]string, 0, len(event.Sources))
	for _, source := range event.Sources {
		ids = append(ids, source.MessageID)
	}
	return ids
}
