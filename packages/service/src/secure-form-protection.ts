import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { privateDirectory } from "./platform.js";

/** A conservative resource taint marker, not a journal of values or operations. */
export class SecureFormProtectionStore {
  private ready = false;
  constructor(private directory: string) {}

  async prepare() {
    await privateDirectory(this.directory);
    this.ready = true;
  }

  private path(resourceKey: string) {
    if (!this.ready) throw Error("Secure form protection unavailable.");
    return join(
      this.directory,
      `${createHash("sha256").update(resourceKey).digest("hex")}.protected`,
    );
  }

  has(resourceKey: string) {
    try {
      statSync(this.path(resourceKey));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      // Inability to establish the prior state must never restore raw access.
      throw Error("Secure form protection unavailable.");
    }
  }

  /** Synchronous so acceptance cannot race the first browser write. */
  mark(resourceKey: string) {
    const path = this.path(resourceKey);
    let fd: number;
    let created = false;
    try {
      fd = openSync(path, "wx", 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(path, "r");
    }
    try {
      if (created) writeSync(fd, "protected-v1\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (process.platform !== "win32") {
      const directory = openSync(this.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
}
