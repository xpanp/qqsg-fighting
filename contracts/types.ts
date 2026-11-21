/** UTC milliseconds and monotonic relative time remain separate. */
export const SCHEMA_VERSION = 1 as const;
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CaptureSession {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  startedAtMs: number;
  monotonicAnchorMs: number;
  region: Rect;
}
export interface FrameContext {
  sessionId: string;
  frameId: string;
  capturedAtMs: number;
  relativeMs: number;
}
export interface OcrLine {
  text: string;
  box?: number[];
  confidence?: number;
}
export interface MergedMessage {
  id: string;
  sessionId: string;
  text: string;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  revision: number;
  observations: number;
  gameTime?: string;
  firstFrameId?: string;
  lastFrameId?: string;
}
export interface RecordingSegment {
  schemaVersion: 1;
  sourceId: string;
  id: string;
  sessionId: string;
  segment: number;
  mimeType: string;
  startedUtcMs: number;
  endedUtcMs?: number;
  startedMono: number;
  endedMono?: number;
  chunkCount: number;
  bytes: number;
  status: "recording" | "complete" | "error";
  savedToDirectory?: boolean;
  fileName?: string;
  errors?: string[];
  [key: string]: unknown;
}
/** Reserved: phase one does not create a transport or send these records. */
export interface SyncBatch {
  schemaVersion: 1;
  batchId: string;
  sourceId: string;
  messages: MergedMessage[];
}
export interface SyncAck {
  batchId: string;
  accepted: { id: string; revision: number }[];
}
