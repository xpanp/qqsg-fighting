import test from "node:test";
import assert from "node:assert/strict";
import {
  signature,
  change,
  splitLines,
  tensorInput,
  cropWithBorder,
} from "../../frontend/src/ocr/preprocess.js";

function image(width: number, height: number, rgb = [20, 40, 30]) {
  return {
    width,
    height,
    data: Uint8ClampedArray.from(
      { length: width * height * 4 },
      (_, i) => [...rgb, 255][i % 4],
    ),
  };
}

test("flat screenshot has no fabricated text rows, including a small selection", () => {
  for (const [width, height] of [
    [48, 48],
    [8, 8],
    [40, 20],
  ]) {
    const input = image(width, height);
    assert.equal(signature(input).some(Boolean), false);
    assert.deepEqual(splitLines(input).boxes, []);
  }
});

test("change gate detects one newly arriving text band even in a tall chat window", () => {
  const width = 200,
    height = 600;
  const before = new Uint8Array(width * height),
    after = new Uint8Array(before);
  assert.equal(change(before, after, width), 0);
  for (let y = 480; y < 492; y++) after.fill(1, y * width, (y + 1) * width);
  assert.equal(change(before, after, width), 1);
  assert.equal(change(null, after, width), 1);
});

test("recognizer tensor uses BGR normalized channels and zero padded width", () => {
  const output = tensorInput(image(48, 48, [255, 0, 0]));
  assert.deepEqual(output.shape, [1, 3, 48, 320]);
  const plane = 48 * 320;
  assert.equal(output.data[0], -1);
  assert.equal(output.data[plane], -1);
  assert.equal(output.data[plane * 2], 1);
  assert.equal(output.data[100], 0);
  assert.equal(output.data.every(Number.isFinite), true);
});

test("cropping preserves visible RGB data without adding unrelated background", () => {
  const input = image(40, 30, [255, 255, 0]);
  const output = cropWithBorder(input, [5, 6, 25, 20]);
  assert.equal(output.width, 26);
  assert.equal(output.height, 18);
  assert.equal(output.data.length, output.width * output.height * 4);
  assert.deepEqual(Array.from(output.data.slice(0, 4)), [255, 255, 0, 255]);
  assert.deepEqual(Array.from(output.data.slice(-4)), [255, 255, 0, 255]);
});

function chatTexture(color: number[], lines = [12, 33, 54, 75, 96]) {
  const input = image(300, 126);
  for (let y = 0; y < input.height; y++)
    for (let x = 0; x < input.width; x++) {
      const rgb =
        (Math.floor(x / 3) + Math.floor(y / 3)) % 2
          ? [155, 125, 75]
          : [45, 70, 35];
      input.data.set([...rgb, 255], (y * input.width + x) * 4);
    }
  for (const top of lines)
    for (let y = Math.max(0, top); y < Math.min(input.height, top + 12); y++)
      for (let x = 18; x < 260; x++)
        if (x % 8 < 3)
          input.data.set([...color, 255], (y * input.width + x) * 4);
  return input;
}

test("bright chat glyphs on textured scenery retain five compact rows across text colors", () => {
  for (const color of [
    [255, 255, 0],
    [240, 240, 240],
    [0, 255, 40],
    [255, 40, 220],
    [0, 240, 255],
  ]) {
    const result = splitLines(chatTexture(color));
    assert.equal(result.boxes.length, 5, `text color ${color}`);
    assert.equal(result.dropped.length, 0);
    assert.ok(result.boxes.every((box: number[]) => box[3] - box[1] <= 20));
  }
});

test("cropped edge fragments are discarded while internal rows remain on textured background", () => {
  const result = splitLines(chatTexture([255, 255, 0], [-6, 20, 48, 76, 121]));
  assert.equal(result.boxes.length, 3);
  assert.ok(
    result.dropped.some(
      (row: { reason: string }) => row.reason === "top_capture_edge",
    ),
  );
  assert.ok(
    result.dropped.some(
      (row: { reason: string }) => row.reason === "bottom_capture_edge",
    ),
  );
});

test("small viewports keep complete first and last rows rather than treating all rows as clipped", () => {
  const result = splitLines(chatTexture([0, 255, 255], [6, 37, 68, 100]));
  assert.equal(result.boxes.length, 4);
  assert.equal(result.dropped.length, 0);
});
