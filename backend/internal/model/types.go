package model

type Context struct {
	SessionStartedAtMs int64   `json:"sessionStartedAtMs"`
	Realm              string  `json:"realm"`
	Line               string  `json:"line"`
	Character          string  `json:"character,omitempty"`
	ClockOffsetMs      float64 `json:"clockOffsetMs"`
	ClockUncertaintyMs float64 `json:"clockUncertaintyMs"`
}
type Message struct {
	ID                string `json:"id"`
	SessionID         string `json:"sessionId"`
	Text              string `json:"text"`
	Revision          int    `json:"revision"`
	FirstObservedAtMs int64  `json:"firstObservedAtMs"`
	LastObservedAtMs  int64  `json:"lastObservedAtMs"`
	Observations      int    `json:"observations"`
	GameTime          string `json:"gameTime,omitempty"`
	FirstFrameID      string `json:"firstFrameId,omitempty"`
	LastFrameID       string `json:"lastFrameId,omitempty"`
}
type Batch struct {
	SchemaVersion int       `json:"schemaVersion"`
	BatchID       string    `json:"batchId"`
	SourceID      string    `json:"sourceId"`
	SessionID     string    `json:"sessionId"`
	Context       Context   `json:"context"`
	Messages      []Message `json:"messages"`
}
type Item struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionId"`
	Revision  int    `json:"revision"`
	Code      string `json:"code,omitempty"`
	Retryable bool   `json:"retryable"`
}
type Ack struct {
	BatchID  string `json:"batchId"`
	JobID    string `json:"jobId,omitempty"`
	Accepted []Item `json:"accepted"`
	Rejected []Item `json:"rejected"`
}
type Alias struct {
	Canonical string `json:"canonical"`
	Alias     string `json:"alias"`
}
type NameConfig struct {
	ID          string   `json:"id"`
	NameA       []string `json:"nameA"`
	NameB       []string `json:"nameB"`
	NameOthers  []string `json:"nameOthers"`
	Aliases     []Alias  `json:"aliases"`
	Blacklist   []string `json:"blacklist"`
	CreatedAtMs int64    `json:"createdAtMs"`
}
type SourceMessage struct {
	SourceID          string  `json:"sourceId"`
	SessionID         string  `json:"sessionId"`
	MessageID         string  `json:"messageId"`
	Revision          int     `json:"revision"`
	Text              string  `json:"text"`
	FirstObservedAtMs int64   `json:"firstObservedAtMs"`
	LastObservedAtMs  int64   `json:"lastObservedAtMs"`
	GameTime          string  `json:"gameTime,omitempty"`
	EventAtMs         int64   `json:"eventAtMs"`
	ReceivedAtMs      int64   `json:"receivedAtMs"`
	Context           Context `json:"context"`
}
type Event struct {
	ID                     string          `json:"id"`
	OccurredAtMs           int64           `json:"occurredAtMs"`
	Text                   string          `json:"text"`
	Killer                 string          `json:"killer"`
	Victim                 string          `json:"victim"`
	KillerFaction          string          `json:"killerFaction"`
	VictimFaction          string          `json:"victimFaction"`
	Status                 string          `json:"status"`
	Reason                 string          `json:"reason"`
	SourceCount            int             `json:"sourceCount"`
	SourceIDs              []string        `json:"sourceIds"`
	ConfigVersion          string          `json:"configVersion"`
	AlgorithmVersion       string          `json:"algorithmVersion"`
	TimeQuality            string          `json:"timeQuality"`
	EventTimeUncertaintyMs *float64        `json:"eventTimeUncertaintyMs"`
	TimeReason             string          `json:"timeReason"`
	Sources                []SourceMessage `json:"-"`
	// Members excludes evidence merely displayed through an administrator merge.
	Members []SourceMessage `json:"-"`
}
type Override struct {
	RequestID   string `json:"requestId"`
	EventID     string `json:"eventId"`
	Killer      string `json:"killer,omitempty"`
	Victim      string `json:"victim,omitempty"`
	Status      string `json:"status,omitempty"`
	Reason      string `json:"reason"`
	Split       bool   `json:"split,omitempty"`
	MergeInto   string `json:"mergeInto,omitempty"`
	Reset       bool   `json:"reset,omitempty"`
	CreatedAtMs int64  `json:"createdAtMs"`
}
type Job struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
	CreatedAtMs  int64  `json:"createdAtMs"`
	FinishedAtMs int64  `json:"finishedAtMs,omitempty"`
	StartMs      int64  `json:"-"`
	EndMs        int64  `json:"-"`
	Full         bool   `json:"-"`
}
