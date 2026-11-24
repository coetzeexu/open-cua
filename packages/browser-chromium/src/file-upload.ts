import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import {
  CuaError,
  operationError,
  type OperationContext,
} from "@cua/contracts";

export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function uploadPaths(raw: unknown): string[] {
  const paths = typeof raw === "string" ? [raw] : raw;
  if (
    !Array.isArray(paths) ||
    paths.length > MAX_UPLOAD_FILES ||
    paths.some(
      (path) =>
        typeof path !== "string" || !isAbsolute(path) || path.includes("\0"),
    )
  )
    throw operationError("INVALID_ARGUMENT", {
      message:
        "setInputFiles requires an absolute path or up to 20 absolute paths on the CUA service host; [] clears the input.",
    });
  return [...paths];
}

const mimeTypes: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/** Read on the service host, then send bytes (also works with remote Chromium). */
export async function readUploadFiles(paths: string[], ctx: OperationContext) {
  const files: { name: string; mimeType: string; buffer: Buffer }[] = [];
  let total = 0;
  for (const path of paths) {
    ctx.check();
    try {
      // Nonblocking open avoids hanging on named pipes; fstat rejects all special files.
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES - total)
          throw operationError("INVALID_ARGUMENT", {
            message:
              "Upload paths must be regular files with a combined size of at most 50 MiB.",
          });
        const chunks: Buffer[] = [];
        // Bound reads even if the file grows after fstat.
        for await (const chunk of file.createReadStream({
          autoClose: false,
          signal: ctx.signal,
        })) {
          ctx.check();
          const bytes = chunk as Buffer;
          total += bytes.length;
          if (total > MAX_UPLOAD_BYTES)
            throw operationError("INVALID_ARGUMENT", {
              message: "Upload files exceed the combined 50 MiB limit.",
            });
          chunks.push(bytes);
        }
        files.push({
          name: basename(path),
          mimeType:
            mimeTypes[extname(path).toLowerCase()] ??
            "application/octet-stream",
          buffer: Buffer.concat(chunks),
        });
      } finally {
        await file.close();
      }
    } catch (error) {
      ctx.check();
      if (error instanceof CuaError) throw error;
      throw operationError("INVALID_ARGUMENT", {
        message:
          "An upload file could not be read on the CUA service host. Check the absolute path and read permissions.",
      });
    }
  }
  return files;
}
