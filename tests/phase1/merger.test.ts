import test from "node:test";
import assert from "node:assert/strict";
import {
  MessageMerger,
  messageCandidates,
} from "../../frontend/src/messages/merger.ts";

const line = (text: string, y = 20) => ({
  text,
  box: [0, y, 600, y + 16],
  confidence: 0.9,
});
const context = (n: number, sessionId = "test-session") => ({
  sessionId,
  frameId: `frame-${n}`,
  capturedAtMs: 1_700_000_000_000 + n * 1000,
  relativeMs: n * 1000,
});
const A = "[地图][14:30:00]测试甲在战斗中击败了测试乙";
const B = "[地图][14:30:01]测试丙在战斗中击败了测试丁";
const C = "[系统]欢迎进入测试地图";

test("stationary observations retain one message and stable identity", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  const first = merger.list()[0];
  assert.ok(first, "complete message must be published");
  for (let n = 1; n <= 20; n++) merger.ingest([line(A)], context(n));
  const rows = merger.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].firstObservedAtMs, context(0).capturedAtMs);
  assert.equal(rows[0].lastObservedAtMs, context(20).capturedAtMs);
});

test("overlap after scroll adds only newly visible message", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A, 20), line(B, 40)], context(0));
  const ids = merger.list().map((row) => row.id);
  merger.ingest([line(B, 20), line(C, 40)], context(1));
  assert.equal(merger.list().length, 3);
  assert.deepEqual(
    merger
      .list()
      .slice(0, 2)
      .map((row) => row.id),
    ids,
  );
});

test("a corrected OCR reading revises the existing message", () => {
  const merger = new MessageMerger("test-session");
  const typo = A.replace("测试乙", "测试已");
  merger.ingest([line(typo)], context(0));
  const first = merger.list()[0];
  for (let n = 1; n < 5; n++) merger.ingest([line(A)], context(n));
  assert.equal(merger.list().length, 1);
  const corrected = merger.list()[0];
  assert.equal(corrected.id, first.id);
  assert.equal(corrected.text, A);
  assert.ok(corrected.revision > first.revision);
  assert.equal(corrected.firstObservedAtMs, context(0).capturedAtMs);
});

test("same text can be a new occurrence after leaving the visible history", () => {
  const merger = new MessageMerger("test-session");
  const repeat = "[大喇叭]出售测试装备";
  merger.ingest([line(repeat)], context(0));
  merger.ingest([line(C)], context(1));
  merger.ingest([line(B)], context(2));
  merger.ingest([line(repeat)], context(3));
  const repeats = merger.list().filter((row) => row.text === repeat);
  assert.equal(repeats.length, 2);
  assert.notEqual(repeats[0].id, repeats[1].id);
});

test("two identical messages simultaneously visible are distinct occurrences", () => {
  const merger = new MessageMerger("test-session");
  const repeat = "[同屏]测试重复文本";
  merger.ingest([line(repeat, 20), line(repeat, 40)], context(0));
  merger.ingest([line(repeat, 20), line(repeat, 40)], context(1));
  const rows = merger.list();
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
});

test("a blank OCR observation does not itself delete persisted messages", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  merger.ingest([], context(1));
  assert.equal(merger.list().length, 1);
});

test("a lower-confidence shorter reading does not truncate a complete message", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  merger.ingest([{ ...line(A.slice(0, -2)), confidence: 0.3 }], context(1));
  assert.equal(merger.list().length, 1);
  assert.equal(merger.list()[0].text, A);
});

test("wrapped lines join under their channel and the next channel starts a new message", () => {
  const rows = messageCandidates([
    line("上方被截断的旧消息"),
    line("[地 图][14:30:00]测试甲在战斗中击"),
    line("败了测试乙"),
    line("[大喇叭]出售测试装备"),
  ]);
  assert.deepEqual(
    rows.map((row) => row.text),
    [A, "[大喇叭]出售测试装备"],
  );
});

test("messages with distinct game timestamps cannot collapse even when otherwise identical", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  merger.ingest([line(A.replace("14:30:00", "14:30:02"))], context(1));
  assert.equal(merger.list().length, 2);
});

test("reprocessing the same frame is idempotent", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  const first = merger.list()[0];
  assert.deepEqual(merger.ingest([line(A)], context(0)), []);
  assert.deepEqual(merger.list()[0], first);
});

test("rejects a result arriving from another capture session", () => {
  const merger = new MessageMerger("test-session");
  assert.throws(
    () => merger.ingest([line(A)], context(0, "old-session")),
    /session/i,
  );
  assert.equal(merger.list().length, 0);
});

test("an obvious truncated battle tail is held until a complete reading is available", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line("[地图]测试甲在战斗中击败了")], context(0));
  assert.equal(merger.list().length, 0, "missing victim must not be published");
  merger.ingest([line(A)], context(1));
  assert.equal(merger.list().length, 1);
  assert.equal(merger.list()[0].text, A);
});

test("unanchored edge text is not published as a standalone message", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line("败了测试乙")], context(0));
  assert.equal(merger.list().length, 0);
});

test("observations retain frame provenance when the text is revised", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A.replace("测试乙", "测试已"))], context(0));
  for (let n = 1; n <= 4; n++) merger.ingest([line(A)], context(n));
  const row = merger.list()[0];
  assert.equal(row.firstFrameId, context(0).frameId);
  assert.equal(row.lastFrameId, context(4).frameId);
});

test("repeated low confidence truncation cannot outvote a complete battle message", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A)], context(0));
  for (let n = 1; n <= 5; n++)
    merger.ingest([{ ...line(A.slice(0, -2)), confidence: 0.3 }], context(n));
  assert.equal(merger.list().length, 1);
  assert.equal(merger.list()[0].text, A);
});

test("similar battle templates without timestamp or overlap evidence stay distinct", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line("[地图]测试甲在战斗中击败了测试乙", 20)], context(0));
  merger.ingest([line("[地图]测试甲在战斗中击败了测试丙", 40)], context(1));
  assert.equal(merger.list().length, 2);
});

test("different victims in the same second with changed row position stay distinct", () => {
  const merger = new MessageMerger("test-session");
  merger.ingest([line(A, 20)], context(0));
  merger.ingest([line(A.replace("测试乙", "测试丙"), 40)], context(1));
  assert.equal(merger.list().length, 2);
});
