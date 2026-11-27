import test from "node:test";
import assert from "node:assert/strict";
import { parseCaptureIdentity } from "../../frontend/src/capture/identity.ts";

test("window title supplies realm and line without guessing character", () => {
  const result = parseCaptureIdentity({
    windowTitle: "QQ三国1.0Beta83Build37 得陇望蜀 12线",
  });
  assert.equal(result.realm, "得陇望蜀");
  assert.equal(result.line, "12");
  assert.equal(result.character, undefined);
});
test("Chinese line numbers and fullwidth digits are normalised", () => {
  for (const line of ["十二", "１２", "12"])
    assert.equal(
      parseCaptureIdentity({ titleLines: [`得陇望蜀[${line}线]`] }).line,
      "12",
    );
  assert.equal(
    parseCaptureIdentity({ windowTitle: "得陇望蜀 十线" }).line,
    "10",
  );
  assert.equal(
    parseCaptureIdentity({ windowTitle: "得陇望蜀 二十一線" }).line,
    "21",
  );
});
test("wrapped title uses only header evidence", () => {
  assert.equal(
    parseCaptureIdentity({ titleLines: ["得陇望蜀", "十二线"] }).realm,
    "得陇望蜀",
  );
  assert.equal(
    parseCaptureIdentity({ lines: ["得陇望蜀 十二线"] }).realm,
    undefined,
  );
});
test("dedicated HUD or explicit label supplies a name and preserves punctuation", () => {
  assert.equal(
    parseCaptureIdentity({ characterLines: ["丶灬尛輝__僞裝"] }).character,
    "丶灬尛輝__僞裝",
  );
  assert.equal(
    parseCaptureIdentity({ lines: ["角色名：暗语飘蓝"] }).character,
    "暗语飘蓝",
  );
  assert.equal(
    parseCaptureIdentity({ lines: ["暗语飘蓝"] }).character,
    undefined,
  );
  assert.equal(
    parseCaptureIdentity({ characterLines: ["言 流浪诗人"] }).character,
    "言 流浪诗人",
  );
});
test("ambiguous or missing header evidence remains unknown", () => {
  for (const windowTitle of [
    "窗口12线",
    "QQ三国",
    "得陇望蜀0线",
    "得陇望蜀1000线",
    "当前线路12线",
  ])
    assert.equal(
      parseCaptureIdentity({ windowTitle }).line,
      undefined,
      windowTitle,
    );
  assert.equal(
    parseCaptureIdentity({ characterLines: ["暗语飘蓝", "妗苏"] }).character,
    undefined,
  );
});
test("UI words and combat text are not character-name evidence", () => {
  for (const name of [
    "生命",
    "等级",
    "LV150",
    "[地图]甲在战斗中击败了乙",
    "12345",
    "A".repeat(17),
  ])
    assert.equal(
      parseCaptureIdentity({ characterLines: [name] }).character,
      undefined,
      name,
    );
});

test("Chinese line directly after realm does not become part of the realm", () => {
  const value = parseCaptureIdentity({ windowTitle: "得陇望蜀十二线" });
  assert.equal(value.realm, "得陇望蜀");
  assert.equal(value.line, "12");
});
