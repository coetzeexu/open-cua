import { test } from "node:test";
import assert from "node:assert/strict";
test("preview contain scaling maps clicks to the actual viewport and ignores letterbox", async () => {
  const { viewportPoint } = await import(
    new URL("../packages/preview/public/geometry.js", import.meta.url).href
  );
  const frame = { width: 1280, height: 720 };
  assert.deepEqual(
    viewportPoint(
      { left: 20, top: 30, width: 640, height: 360 },
      frame,
      340,
      210,
    ),
    { x: 640, y: 360 },
  );
  assert.deepEqual(
    viewportPoint(
      { left: 0, top: 0, width: 800, height: 360 },
      frame,
      400,
      180,
    ),
    { x: 640, y: 360 },
  );
  assert.equal(
    viewportPoint({ left: 0, top: 0, width: 800, height: 360 }, frame, 20, 180),
    null,
  );
  assert.deepEqual(
    viewportPoint(
      { left: 0, top: 0, width: 640, height: 500 },
      frame,
      320,
      250,
    ),
    { x: 640, y: 360 },
  );
  assert.equal(
    viewportPoint({ left: 0, top: 0, width: 640, height: 500 }, frame, 320, 30),
    null,
  );
  assert.equal(
    viewportPoint({ left: 0, top: 0, width: 0, height: 0 }, frame, 0, 0),
    null,
  );
});
