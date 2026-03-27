import { type Client } from "ssh2";
import { basename, posix as posixPath } from "node:path";

function debugScp(message: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[SCP] ${message}`, details);
    return;
  }

  console.log(`[SCP] ${message}`);
}

function summarizeCommand(command: string): string {
  if (command.length <= 240) {
    return command;
  }

  return `${command.slice(0, 240)}… [len=${command.length}]`;
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveUploadChunkSize(): number {
  const defaultSize = 2 * 1024;
  const raw = process.env.SSH_COMMANDER_UPLOAD_CHUNK_SIZE;

  if (!raw) {
    return defaultSize;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    debugScp("Invalid SSH_COMMANDER_UPLOAD_CHUNK_SIZE, using default", {
      raw,
      defaultSize,
    });
    return defaultSize;
  }

  const min = 256;
  const max = 32 * 1024;
  const clamped = Math.max(min, Math.min(max, parsed));

  if (clamped !== parsed) {
    debugScp("Clamped SSH_COMMANDER_UPLOAD_CHUNK_SIZE", {
      requested: parsed,
      applied: clamped,
      min,
      max,
    });
  }

  return clamped;
}

function execCaptureBuffer(client: Client, command: string): Promise<Buffer> {
  return execCaptureBufferWithOptions(client, command);
}

async function execCaptureText(
  client: Client,
  command: string,
): Promise<string> {
  const out = await execCaptureBuffer(client, command);
  return out.toString("utf-8");
}

function execCaptureBufferWithOptions(
  client: Client,
  command: string,
  options?: { logCommand?: boolean; label?: string },
): Promise<Buffer> {
  const commandForLog = summarizeCommand(command);
  const logCommand = options?.logCommand ?? true;
  const label = options?.label;

  debugScp("Opening channel", {
    ...(label ? { label } : {}),
    ...(logCommand ? { command: commandForLog } : {}),
  });

  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err || !channel) {
        const message =
          err instanceof Error ? err.message : "Unknown exec error";
        debugScp("Failed to open channel", {
          ...(label ? { label } : {}),
          ...(logCommand ? { command: commandForLog } : {}),
          error: message,
        });
        reject(err ?? new Error("Failed to open transfer channel."));
        return;
      }

      debugScp("Channel opened", {
        ...(label ? { label } : {}),
        ...(logCommand ? { command: commandForLog } : {}),
      });

      const outChunks: Buffer[] = [];
      let stderrText = "";

      channel.on("data", (chunk: Buffer | string) => {
        outChunks.push(
          typeof chunk === "string"
            ? Buffer.from(chunk, "utf-8")
            : Buffer.from(chunk),
        );
      });

      channel.stderr?.on("data", (chunk: Buffer | string) => {
        stderrText +=
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      });

      channel.on("close", (code?: number) => {
        const stderrTrimmed = stderrText.trim();
        if (typeof code === "number" && code !== 0) {
          const msg = stderrTrimmed || `Command failed with code ${code}`;
          debugScp("Channel closed with failure", {
            ...(label ? { label } : {}),
            ...(logCommand ? { command: commandForLog } : {}),
            code,
            stderr: stderrTrimmed,
          });
          reject(new Error(msg));
          return;
        }

        if (stderrTrimmed) {
          debugScp("Channel stderr (non-fatal)", {
            ...(label ? { label } : {}),
            ...(logCommand ? { command: commandForLog } : {}),
            stderr: stderrTrimmed,
          });
        }

        const result = Buffer.concat(outChunks);
        debugScp("Channel completed", {
          ...(label ? { label } : {}),
          ...(logCommand ? { command: commandForLog } : {}),
          bytes: result.length,
        });
        resolve(result);
      });

      channel.on("error", (channelErr: Error) => {
        debugScp("Channel runtime error", {
          ...(label ? { label } : {}),
          ...(logCommand ? { command: commandForLog } : {}),
          error: channelErr.message,
        });
        reject(channelErr);
      });
    });
  });
}

function execSendBuffer(
  client: Client,
  command: string,
  content: Buffer,
  options?: { writeChunkSize?: number },
): Promise<void> {
  debugScp("Opening channel", { command, bytes: content.length });

  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err || !channel) {
        const message =
          err instanceof Error ? err.message : "Unknown exec error";
        debugScp("Failed to open channel", { command, error: message });
        reject(err ?? new Error("Failed to open transfer channel."));
        return;
      }

      debugScp("Channel opened", { command });

      let stderrText = "";
      let settled = false;
      const timeoutMs = Math.max(
        60000,
        Math.ceil(content.length / 65536) * 1000,
      );
      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        debugScp("Upload timeout", {
          command,
          bytes: content.length,
          timeoutMs,
        });
        try {
          channel.end();
        } catch {
          // ignore
        }
        reject(new Error(`Upload timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        fn();
      };

      channel.stderr?.on("data", (chunk: Buffer | string) => {
        stderrText +=
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      });

      channel.on(
        "exit",
        (
          code?: number,
          signal?: string,
          coreDumped?: boolean,
          description?: string,
        ) => {
          debugScp("Channel exit", {
            command,
            code,
            signal,
            coreDumped,
            description,
          });

          finish(() => {
            const stderrTrimmed = stderrText.trim();
            if (typeof code === "number" && code !== 0) {
              const msg = stderrTrimmed || `Command failed with code ${code}`;
              debugScp("Channel exited with failure", {
                command,
                code,
                stderr: stderrTrimmed,
              });
              reject(new Error(msg));
              return;
            }

            if (stderrTrimmed) {
              debugScp("Channel stderr (non-fatal)", {
                command,
                stderr: stderrTrimmed,
              });
            }

            debugScp("Channel completed on exit", {
              command,
              bytes: content.length,
            });
            resolve();
          });
        },
      );

      channel.on("close", (code?: number) => {
        finish(() => {
          const stderrTrimmed = stderrText.trim();
          if (typeof code === "number" && code !== 0) {
            const msg = stderrTrimmed || `Command failed with code ${code}`;
            debugScp("Channel closed with failure", {
              command,
              code,
              stderr: stderrTrimmed,
            });
            reject(new Error(msg));
            return;
          }

          if (stderrTrimmed) {
            debugScp("Channel stderr (non-fatal)", {
              command,
              stderr: stderrTrimmed,
            });
          }

          debugScp("Channel completed", { command, bytes: content.length });
          resolve();
        });
      });

      channel.on("error", (channelErr: Error) => {
        finish(() => {
          debugScp("Channel runtime error", {
            command,
            error: channelErr.message,
          });
          reject(channelErr);
        });
      });

      const CHUNK_SIZE = Math.max(256, options?.writeChunkSize ?? 64 * 1024);
      let offset = 0;

      const writeNext = () => {
        if (settled) {
          return;
        }

        while (offset < content.length) {
          const nextOffset = Math.min(content.length, offset + CHUNK_SIZE);
          const chunk = content.subarray(offset, nextOffset);
          const canContinue = channel.write(chunk);
          offset = nextOffset;

          if (!canContinue) {
            channel.once("drain", writeNext);
            return;
          }
        }

        debugScp("Upload payload sent, ending stdin", {
          command,
          bytes: content.length,
        });
        channel.end();
      };

      writeNext();
    });
  });
}

async function getRemoteFileSizeBytes(
  client: Client,
  remotePath: string,
): Promise<number | undefined> {
  const escapedRemotePath = escapeShellArg(remotePath);
  const text = await execCaptureText(
    client,
    `wc -c < ${escapedRemotePath} 2>/dev/null || true`,
  );

  const parsed = Number(text.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

async function uploadViaChunkedExec(
  client: Client,
  remotePath: string,
  escapedTempRemotePath: string,
  content: Buffer,
): Promise<void> {
  const chunkSize = Math.min(resolveUploadChunkSize(), 2 * 1024);
  const chunkCount = Math.max(1, Math.ceil(content.length / chunkSize));

  debugScp("Fallback chunked upload start", {
    remotePath,
    chunkSize,
    chunkCount,
  });

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(content.length, start + chunkSize);
    const chunk = content.subarray(start, end);
    const encoded = chunk.toString("base64");

    const appendCommand = `printf %s ${escapeShellArg(encoded)} | base64 -d >> ${escapedTempRemotePath}`;
    await execCaptureBufferWithOptions(client, appendCommand, {
      logCommand: false,
      label: `fallback append chunk ${chunkIndex + 1}/${chunkCount}`,
    });

    if (
      chunkIndex === 0 ||
      (chunkIndex + 1) % 10 === 0 ||
      chunkIndex + 1 === chunkCount
    ) {
      debugScp("Fallback chunk appended", {
        remotePath,
        chunkIndex: chunkIndex + 1,
        chunkCount,
      });
    }
  }
}

export function resolveRemoteDestinationPath(
  remoteCwd: string,
  fileName: string,
): string {
  const safeName = basename(fileName).trim();
  const normalizedCwd = remoteCwd?.trim() || "/";

  if (!safeName) {
    throw new Error("Invalid target file name.");
  }

  return posixPath.join(normalizedCwd, safeName);
}

export async function downloadRemoteFile(
  client: Client,
  remotePath: string,
): Promise<Buffer> {
  debugScp("Download start", { remotePath });
  const command = `cat -- ${escapeShellArg(remotePath)}`;
  const fileBuffer = await execCaptureBuffer(client, command);
  debugScp("Download completed", { remotePath, size: fileBuffer.length });
  return fileBuffer;
}

export async function uploadRemoteFile(
  client: Client,
  remotePath: string,
  content: Buffer,
): Promise<void> {
  debugScp("Upload start", { remotePath, size: content.length });

  const escapedRemotePath = escapeShellArg(remotePath);
  const tempRemotePath = `${remotePath}.sshCommander-upload-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const escapedTempRemotePath = escapeShellArg(tempRemotePath);

  await execCaptureBuffer(client, `: > ${escapedTempRemotePath}`);

  const streamChunkSize = resolveUploadChunkSize();
  debugScp("Upload stream chunk size", {
    remotePath,
    streamChunkSize,
  });

  let usedFallback = false;

  try {
    await execSendBuffer(client, `cat > ${escapedTempRemotePath}`, content, {
      writeChunkSize: streamChunkSize,
    });
  } catch (error) {
    usedFallback = true;
    const message = error instanceof Error ? error.message : String(error);
    debugScp("Stream upload failed, switching to fallback", {
      remotePath,
      error: message,
    });

    await execCaptureBuffer(client, `: > ${escapedTempRemotePath}`);
    await uploadViaChunkedExec(
      client,
      remotePath,
      escapedTempRemotePath,
      content,
    );
  }

  const remoteSize = await getRemoteFileSizeBytes(client, tempRemotePath);
  if (remoteSize !== content.length) {
    debugScp("Remote temp file size mismatch", {
      remotePath,
      expectedBytes: content.length,
      actualBytes: remoteSize,
      usedFallback,
    });

    if (!usedFallback) {
      debugScp("Retrying via fallback after size mismatch", { remotePath });
      await execCaptureBuffer(client, `: > ${escapedTempRemotePath}`);
      await uploadViaChunkedExec(
        client,
        remotePath,
        escapedTempRemotePath,
        content,
      );
    }

    const verifiedSize = await getRemoteFileSizeBytes(client, tempRemotePath);
    if (verifiedSize !== content.length) {
      throw new Error(
        `Uploaded size mismatch (expected ${content.length}, got ${verifiedSize ?? "unknown"}).`,
      );
    }
  }

  await execCaptureBuffer(
    client,
    `mv -f ${escapedTempRemotePath} ${escapedRemotePath}`,
  );

  debugScp("Upload completed", { remotePath, size: content.length });
}

export async function uploadRemoteFileToCwd(
  client: Client,
  remoteCwd: string,
  fileName: string,
  content: Buffer,
): Promise<string> {
  const remotePath = resolveRemoteDestinationPath(remoteCwd, fileName);
  debugScp("Upload to CWD resolved destination", {
    remoteCwd,
    fileName,
    remotePath,
  });
  await uploadRemoteFile(client, remotePath, content);
  return remotePath;
}
