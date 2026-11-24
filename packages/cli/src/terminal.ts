import { openSync, closeSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { emitKeypressEvents, type Key } from "node:readline";

/** Always open the controlling terminal, never read answers from piped stdin. */
export function openTerminal() {
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  let input: ReadStream | undefined;
  let output: WriteStream | undefined;
  try {
    // Windows SetConsoleMode needs write access even on the input handle.
    inputFd = openSync(
      process.platform === "win32" ? "\\\\.\\CONIN$" : "/dev/tty",
      "r+",
    );
    outputFd = openSync(
      process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty",
      "r+",
    );
    input = new ReadStream(inputFd);
    output = new WriteStream(outputFd);
    input.setRawMode(true);
    input.setRawMode(false);
    emitKeypressEvents(input);
    input.pause();
    return new Terminal(input, output);
  } catch {
    if (input) input.destroy();
    else if (inputFd !== undefined) closeSync(inputFd);
    if (output) output.destroy();
    else if (outputFd !== undefined) closeSync(outputFd);
    throw Error("This command requires an interactive terminal.");
  }
}

class Terminal {
  constructor(
    private input: ReadStream,
    private output: WriteStream,
  ) {}
  async prompt(question: string, secret = false): Promise<string> {
    const { input, output } = this;
    // Fail closed: never collect a secret if disabling echo fails.
    input.setRawMode(true);
    let text = "";
    try {
      output.write(question);
      return await new Promise<string>((resolve, reject) => {
        const finish = (error?: Error) => {
          input.removeListener("keypress", onKey);
          input.removeListener("error", onError);
          input.removeListener("end", onEnd);
          input.pause();
          output.write("\r\n");
          if (error) reject(error);
          else resolve(text);
        };
        const onError = () => finish(Error("Terminal input failed."));
        const onEnd = () => finish(Error("Terminal input closed."));
        const onKey = (value: string | undefined, key: Key) => {
          if (key.ctrl && (key.name === "c" || key.name === "d"))
            return finish(Error("Input cancelled."));
          if (key.name === "return" || key.name === "enter") return finish();
          if (key.name === "backspace") {
            if (text) {
              text = Array.from(text).slice(0, -1).join("");
              if (!secret) output.write("\b \b");
            }
          } else if (
            value &&
            !key.ctrl &&
            !key.meta &&
            !/[\x00-\x1f\x7f]/.test(value)
          ) {
            text += value;
            if (!secret) output.write(value);
          }
        };
        input.on("keypress", onKey);
        input.once("error", onError);
        input.once("end", onEnd);
        input.resume();
      });
    } finally {
      input.setRawMode(false);
    }
  }
  close() {
    try {
      this.input.setRawMode(false);
    } finally {
      this.input.destroy();
      this.output.destroy();
    }
  }
}
