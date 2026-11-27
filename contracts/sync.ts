import type { MergedMessage } from "./types";
/** Wire v2 only. Existing local recording/message schema remains v1. */
export interface SyncContext {
  sessionStartedAtMs: number;
  realm: string;
  line: string;
  character?: string;
  clockOffsetMs?: number;
  clockUncertaintyMs?: number;
}
export interface SyncBatchV2 {
  schemaVersion: 2;
  batchId: string;
  sourceId: string;
  sessionId: string;
  context: SyncContext;
  messages: MergedMessage[];
}
export interface SyncAckV2 {
  batchId: string;
  jobId?: string;
  accepted: { id: string; sessionId: string; revision: number }[];
  rejected: { id: string; sessionId: string; revision: number; code: string; retryable: boolean }[];
}
