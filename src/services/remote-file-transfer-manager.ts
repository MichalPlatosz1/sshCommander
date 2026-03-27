import { type Client } from "ssh2";
import { PathManager } from "./ssh-runtime-utils.js";

/**
 * Options for executing a remote command and capturing output.
 */
type SshCommandCaptureOptions = {
  logCommand?: boolean;
  label?: string;
};

/**
 * Options for executing a remote command with streamed stdin input.
 */
type SshCommandStreamInputOptions = {
  writeChunkSize?: number;
};

/**
 * Centralized logger for transfer-related events.
 */
function logTransferEvent(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (details) {
    console.log(`[SCP] ${message}`, details);
    return;
  }

  console.log(`[SCP] ${message}`);
}

/**
 * Low-level SSH gateway for SCP transfer operations.
 *
 * Responsibilities:
 * - execute remote commands and capture stdout/stderr
 * - stream binary payloads over SSH channel stdin
 * - provide consistent error handling and transfer logging
 */
class SshGateway {
  /**
   * Executes a remote command and captures stdout as raw bytes.
   *
   * On non-zero exit code, rejects with stderr text when available.
   *
   * @param client Connected SSH client.
   * @param command Remote shell command to execute.
   * @param options Optional logging behavior for command visibility.
   * @returns Captured stdout buffer.
   */
  async executeCommandToBuffer(
    client: Client,
    command: string,
    options?: SshCommandCaptureOptions,
  ): Promise<Buffer> {
    const logCommand = options?.logCommand ?? true;
    const label = options?.label;

    logTransferEvent("Opening channel", {
      ...(label ? { label } : {}),
      ...(logCommand ? { command } : {}),
    });

    return await new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err || !channel) {
          const message =
            err instanceof Error ? err.message : "Unknown exec error";
          logTransferEvent("Failed to open channel", {
            ...(label ? { label } : {}),
            ...(logCommand ? { command } : {}),
            error: message,
          });
          reject(err ?? new Error("Failed to open transfer channel."));
          return;
        }

        logTransferEvent("Channel opened", {
          ...(label ? { label } : {}),
          ...(logCommand ? { command } : {}),
        });

        const chunks: Buffer[] = [];
        let stderrText = "";

        channel.on("data", (chunk: Buffer | string) => {
          chunks.push(
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
            logTransferEvent("Channel closed with failure", {
              ...(label ? { label } : {}),
              ...(logCommand ? { command } : {}),
              code,
              stderr: stderrTrimmed,
            });
            reject(
              new Error(stderrTrimmed || `Command failed with code ${code}`),
            );
            return;
          }

          if (stderrTrimmed) {
            logTransferEvent("Channel stderr (non-fatal)", {
              ...(label ? { label } : {}),
              ...(logCommand ? { command } : {}),
              stderr: stderrTrimmed,
            });
          }

          const output = Buffer.concat(chunks);
          logTransferEvent("Channel completed", {
            ...(label ? { label } : {}),
            ...(logCommand ? { command } : {}),
            bytes: output.length,
          });
          resolve(output);
        });

        channel.on("error", (channelErr: Error) => {
          logTransferEvent("Channel runtime error", {
            ...(label ? { label } : {}),
            ...(logCommand ? { command } : {}),
            error: channelErr.message,
          });
          reject(channelErr);
        });
      });
    });
  }

  /**
   * Executes a remote command and streams a local buffer to channel stdin.
   *
   * Intended for upload-like flows (for example `cat > file`). The payload
   * is written in chunks and respects channel backpressure (`drain` event).
   *
   * @param client Connected SSH client.
   * @param command Remote shell command that reads from stdin.
   * @param content Raw payload to send.
   * @param options Optional write chunk size override.
   */
  async executeCommandToBufferStream(
    client: Client,
    command: string,
    content: Buffer,
    options?: SshCommandStreamInputOptions,
  ): Promise<void> {
    logTransferEvent("Opening channel", { command, bytes: content.length });

    await new Promise<void>((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err || !channel) {
          const message =
            err instanceof Error ? err.message : "Unknown exec error";
          logTransferEvent("Failed to open channel", {
            command,
            error: message,
          });
          reject(err ?? new Error("Failed to open transfer channel."));
          return;
        }

        logTransferEvent("Channel opened", { command });

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
          logTransferEvent("Upload timeout", {
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

        const finish = (cb: () => void) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timeoutHandle);
          cb();
        };

        channel.stderr?.on("data", (chunk: Buffer | string) => {
          stderrText +=
            typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });

        const handleClose = (code?: number) => {
          finish(() => {
            const stderrTrimmed = stderrText.trim();
            if (typeof code === "number" && code !== 0) {
              logTransferEvent("Channel closed with failure", {
                command,
                code,
                stderr: stderrTrimmed,
              });
              reject(
                new Error(stderrTrimmed || `Command failed with code ${code}`),
              );
              return;
            }

            if (stderrTrimmed) {
              logTransferEvent("Channel stderr (non-fatal)", {
                command,
                stderr: stderrTrimmed,
              });
            }

            logTransferEvent("Channel completed", {
              command,
              bytes: content.length,
            });
            resolve();
          });
        };

        channel.on("close", handleClose);
        channel.on("exit", (code?: number) => handleClose(code));

        channel.on("error", (channelErr: Error) => {
          finish(() => {
            logTransferEvent("Channel runtime error", {
              command,
              error: channelErr.message,
            });
            reject(channelErr);
          });
        });

        const chunkSize = Math.max(256, options?.writeChunkSize ?? 64 * 1024);
        let offset = 0;

        const writeNext = () => {
          if (settled) {
            return;
          }

          while (offset < content.length) {
            const nextOffset = Math.min(content.length, offset + chunkSize);
            const chunk = content.subarray(offset, nextOffset);
            const canContinue = channel.write(chunk);
            offset = nextOffset;

            if (!canContinue) {
              channel.once("drain", writeNext);
              return;
            }
          }

          logTransferEvent("Upload payload sent, ending stdin", {
            command,
            bytes: content.length,
          });
          channel.end();
        };

        writeNext();
      });
    });
  }
}

/**
 * Gateway for high-level remote file transfer operations.
 *
 * This class coordinates upload/download flows on top of `SshGateway`.
 * It is responsible for:
 * - destination resolution (for CWD uploads)
 * - temporary file staging
 * - upload size verification before final move
 * - transfer chunk-size policy from environment
 */
export class ScpTransfer {
  private readonly sshGateway = new SshGateway();
  private readonly defaultUploadChunkSize = 2 * 1024;
  private readonly minUploadChunkSize = 256;
  private readonly maxUploadChunkSize = 32 * 1024;

  /**
   * Downloads a remote file into a local memory buffer.
   *
   * @param client Connected SSH client.
   * @param remotePath Absolute remote file path.
   * @returns Remote file contents as a `Buffer`.
   */
  async downloadRemoteFile(
    client: Client,
    remotePath: string,
  ): Promise<Buffer> {
    logTransferEvent("Download start", { remotePath });
    const fileBuffer = await this.sshGateway.executeCommandToBuffer(
      client,
      `cat -- ${PathManager.quoteForShellArgument(remotePath)}`,
    );
    logTransferEvent("Download completed", {
      remotePath,
      size: fileBuffer.length,
    });
    return fileBuffer;
  }

  /**
   * Uploads a memory buffer to a remote file path.
   *
   * The upload is staged into a temporary remote file first, then verified
   * by size, and finally moved into the target path atomically.
   *
   * @param client Connected SSH client.
   * @param remotePath Absolute destination file path.
   * @param content Raw payload to upload.
   */
  async uploadRemoteFile(
    client: Client,
    remotePath: string,
    content: Buffer,
  ): Promise<void> {
    logTransferEvent("Upload start", { remotePath, size: content.length });

    const escapedRemotePath = PathManager.quoteForShellArgument(remotePath);
    const tempRemotePath = this.createTemporaryRemotePath(remotePath);
    const escapedTempRemotePath =
      PathManager.quoteForShellArgument(tempRemotePath);

    await this.sshGateway.executeCommandToBuffer(
      client,
      `: > ${escapedTempRemotePath}`,
    );

    const streamChunkSize = this.getConfiguredUploadChunkSize();
    logTransferEvent("Upload stream chunk size", {
      remotePath,
      streamChunkSize,
    });

    await this.sshGateway.executeCommandToBufferStream(
      client,
      `cat > ${escapedTempRemotePath}`,
      content,
      { writeChunkSize: streamChunkSize },
    );

    await this.ensureUploadedSizeMatches(
      client,
      remotePath,
      tempRemotePath,
      escapedTempRemotePath,
      content,
    );

    await this.sshGateway.executeCommandToBuffer(
      client,
      `mv -f ${escapedTempRemotePath} ${escapedRemotePath}`,
    );

    logTransferEvent("Upload completed", { remotePath, size: content.length });
  }

  /**
   * Uploads a file to a remote working directory.
   *
   * The final destination path is resolved via
   * `PathManager.getSafeRemoteDestinationPath` before delegating to
   * `uploadRemoteFile`.
   *
   * @param client Connected SSH client.
   * @param remoteCwd Current remote working directory.
   * @param fileName Incoming file name.
   * @param content Raw payload to upload.
   * @returns Resolved absolute remote path where file was uploaded.
   */
  async uploadRemoteFileToCwd(
    client: Client,
    remoteCwd: string,
    fileName: string,
    content: Buffer,
  ): Promise<string> {
    const remotePath = PathManager.getSafeRemoteDestinationPath(
      remoteCwd,
      fileName,
    );
    logTransferEvent("Upload to CWD resolved destination", {
      remoteCwd,
      fileName,
      remotePath,
    });
    await this.uploadRemoteFile(client, remotePath, content);
    return remotePath;
  }

  /**
   * Creates a unique temporary remote path for staged uploads.
   *
   * @param remotePath Final destination path.
   * @returns Temp path near destination with a unique suffix.
   */
  private createTemporaryRemotePath(remotePath: string): string {
    return `${remotePath}.sshCommander-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Reads remote file size in bytes.
   *
   * @param client Connected SSH client.
   * @param remotePath Absolute remote file path.
   * @returns Parsed byte size, or `undefined` when parsing fails.
   */
  private async getRemoteFileSizeInBytes(
    client: Client,
    remotePath: string,
  ): Promise<number | undefined> {
    const sizeTextBuffer = await this.sshGateway.executeCommandToBuffer(
      client,
      `wc -c < ${PathManager.quoteForShellArgument(remotePath)} 2>/dev/null || true`,
    );
    const sizeText = sizeTextBuffer.toString("utf-8");

    const parsed = Number(sizeText.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }

  /**
   * Ensures staged upload size matches local payload size.
   *
   * @param client Connected SSH client.
   * @param remotePath Final destination path (for logging).
   * @param tempRemotePath Temporary staged path.
   * @param escapedTempRemotePath Escaped temp path (kept for context).
   * @param content Local payload buffer.
   * @throws Error when remote size differs from expected payload size.
   */
  private async ensureUploadedSizeMatches(
    client: Client,
    remotePath: string,
    tempRemotePath: string,
    escapedTempRemotePath: string,
    content: Buffer,
  ): Promise<void> {
    const remoteSize = await this.getRemoteFileSizeInBytes(
      client,
      tempRemotePath,
    );
    if (remoteSize === content.length) {
      return;
    }

    logTransferEvent("Remote temp file size mismatch", {
      remotePath,
      expectedBytes: content.length,
      actualBytes: remoteSize,
    });

    throw new Error(
      `Uploaded size mismatch (expected ${content.length}, got ${remoteSize ?? "unknown"}).`,
    );
  }

  /**
   * Resolves upload chunk size from environment and clamps to safe bounds.
   *
   * Environment variable: `SSH_COMMANDER_UPLOAD_CHUNK_SIZE`.
   *
   * @returns Chunk size in bytes.
   */
  private getConfiguredUploadChunkSize(): number {
    const raw = process.env.SSH_COMMANDER_UPLOAD_CHUNK_SIZE;
    if (!raw) {
      return this.defaultUploadChunkSize;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      logTransferEvent(
        "Invalid SSH_COMMANDER_UPLOAD_CHUNK_SIZE, using default",
        {
          raw,
          defaultSize: this.defaultUploadChunkSize,
        },
      );
      return this.defaultUploadChunkSize;
    }

    const clamped = Math.max(
      this.minUploadChunkSize,
      Math.min(this.maxUploadChunkSize, parsed),
    );
    if (clamped !== parsed) {
      logTransferEvent("Clamped SSH_COMMANDER_UPLOAD_CHUNK_SIZE", {
        requested: parsed,
        applied: clamped,
        min: this.minUploadChunkSize,
        max: this.maxUploadChunkSize,
      });
    }

    return clamped;
  }
}
