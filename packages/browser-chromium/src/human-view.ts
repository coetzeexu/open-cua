import type { Page, Frame } from "playwright";
import type { HumanBrowserView } from "@cua/contracts";
/** Host-only CDP channel; Service gates all input with the human control lock. */
export async function openChromiumHumanView(
  page: Page,
): Promise<HumanBrowserView> {
  const cdp = await page.context().newCDPSession(page);
  let closed = false;
  let epoch = 0;
  let pointer: { x: number; y: number; epoch: number } | undefined;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  const releasePointer = async () => {
    clearTimeout(pointerTimer);
    const held = pointer;
    pointer = undefined;
    if (held)
      await cdp
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: held.x,
          y: held.y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => {});
  };
  const navigated = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      epoch++;
      void releasePointer();
    }
  };
  page.on("framenavigated", navigated);
  let frameSequence = 0;
  const frames = new Map<
    number,
    { time: number; epoch: number; width: number; height: number }
  >();
  let capturing:
    | Promise<{ data: string; id: number; width: number; height: number }>
    | undefined;
  const capture = () =>
    (capturing ??= (async () => {
      if (closed) throw Error("View closed");
      const before = epoch;
      // View capture must refer to this tab's viewport. Background surface
      // capture can stall indefinitely on virtual Linux displays.
      await cdp.send("Page.bringToFront");
      const layout = await cdp.send("Page.getLayoutMetrics");
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 65,
        fromSurface: false,
        captureBeyondViewport: false,
      });
      if (epoch !== before) throw Error("Page changed; request a fresh frame");
      const { clientWidth: width, clientHeight: height } =
        layout.cssVisualViewport;
      const id = ++frameSequence;
      frames.set(id, { time: Date.now(), epoch, width, height });
      while (frames.size > 16) frames.delete(frames.keys().next().value!);
      return { data: shot.data, id, width, height };
    })().finally(() => {
      capturing = undefined;
    }));
  const manualInput = async (input: any) => {
    if (closed) throw Error("View closed");
    if (input.type === "pointer" && ["up", "cancel"].includes(input.phase)) {
      await releasePointer();
      return;
    }
    const frame = frames.get(input.frameId);
    if (!frame || frame.epoch !== epoch || Date.now() - frame.time > 5000)
      throw Error("Refresh the live view before sending input");
    {
      if (["click", "wheel", "pointer"].includes(input.type)) {
        if (
          !Number.isFinite(input.x) ||
          !Number.isFinite(input.y) ||
          input.x < 0 ||
          input.y < 0 ||
          input.x >= frame.width ||
          input.y >= frame.height
        )
          throw Error("Invalid coordinates");
        if (input.type === "pointer") {
          if (!["down", "move", "up", "cancel"].includes(input.phase))
            throw Error("Invalid pointer phase");
          if (input.phase === "cancel" || input.phase === "up") {
            await releasePointer();
            return;
          }
          if (input.phase === "down") {
            await releasePointer();
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              x: input.x,
              y: input.y,
              button: "left",
              buttons: 1,
              clickCount: 1,
            });
          } else {
            if (!pointer || pointer.epoch !== epoch)
              throw Error("Pointer is no longer held");
            await cdp.send("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: input.x,
              y: input.y,
              button: "left",
              buttons: 1,
            });
          }
          pointer = { x: input.x, y: input.y, epoch };
          clearTimeout(pointerTimer);
          pointerTimer = setTimeout(() => {
            void releasePointer();
          }, 3000);
        } else if (input.type === "click") {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: input.x,
            y: input.y,
            button: "left",
            clickCount: 1,
          });
        } else {
          if (
            ![input.deltaX, input.deltaY].every(
              (v) => Number.isFinite(v) && Math.abs(v) <= 2000,
            )
          )
            throw Error("Invalid wheel delta");
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: input.x,
            y: input.y,
            deltaX: input.deltaX,
            deltaY: input.deltaY,
          });
        }
      } else if (input.type === "text") {
        if (typeof input.text !== "string" || input.text.length > 2000)
          throw Error("Invalid text");
        await cdp.send("Input.insertText", { text: input.text });
      } else if (input.type === "key") {
        const keys: Record<string, number> = {
          Enter: 13,
          Tab: 9,
          Backspace: 8,
          Delete: 46,
          Escape: 27,
          ArrowLeft: 37,
          ArrowUp: 38,
          ArrowRight: 39,
          ArrowDown: 40,
          Home: 36,
          End: 35,
          PageUp: 33,
          PageDown: 34,
        };
        if (
          !Object.hasOwn(keys, input.key) ||
          !Number.isInteger(input.modifiers ?? 0) ||
          (input.modifiers ?? 0) < 0 ||
          (input.modifiers ?? 0) > 15
        )
          throw Error("Unsupported key");
        const params = {
          key: input.key,
          code: input.key,
          windowsVirtualKeyCode: keys[input.key],
          modifiers: input.modifiers ?? 0,
        };
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          ...params,
        });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      } else if (input.type === "selectAll") {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
          commands: ["selectAll"],
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
        });
      } else throw Error("Unsupported input");
    }
  };
  return {
    capture,
    input: manualInput,
    release: releasePointer,
    async close() {
      if (closed) return;
      closed = true;
      page.off("framenavigated", navigated);
      await releasePointer();
      await cdp.detach().catch(() => {});
      frames.clear();
    },
  };
}
