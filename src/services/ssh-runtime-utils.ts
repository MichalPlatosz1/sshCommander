import { existsSync } from "node:fs";
import { posix as posixPath } from "node:path";
import { type Client } from "ssh2";

type TerminalSessionShape = {
  remoteCwd: string;
  remoteHomeDir: string;
  inputLineBuffer: string;
  inEscapeSequence: boolean;
};

/**
 * Centralized path utilities used by SSH runtime tracking.
 *
 * Responsibilities:
 * - shell-safe quoting for path arguments
 * - quote stripping from parsed tokens
 * - tracked cwd updates based on `cd ...` command lines
 */
export class PathManager {
  /**
   * Escapes a value for use as a single shell argument.
   *
   * @param value Raw value (possibly user-provided).
   * @returns Safely single-quoted shell argument.
   *
   * @example
   * PathManager.quoteForShellArgument("O'Reilly")
   * // => 'O'"'"'Reilly'
   */
  static quoteForShellArgument(value: string): string {
    return `'${value.replace(/'/g, `"'"'`)}'`;
  }

  /**
   * Removes matching wrapping single or double quotes from a token.
   *
   * @param value Potentially quoted token.
   * @returns Unquoted token when wrapping quotes exist.
   */
  static stripWrappingQuotes(value: string): string {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }

    return value;
  }

  /**
   * Gets a safe destination file path inside a remote working directory.
   *
   * The file name is reduced to its basename to avoid path traversal in
   * user-provided names, then joined to the provided remote cwd.
   *
   * @param remoteCwd Remote working directory.
   * @param fileName Candidate file name from user/input.
   * @returns Normalized destination path on remote host.
   *
   * @example
   * const target = PathManager.getSafeRemoteDestinationPath("/home/ubuntu", "../notes.txt");
   * // => "/home/ubuntu/notes.txt"
   */
  static getSafeRemoteDestinationPath(
    remoteCwd: string,
    fileName: string,
  ): string {
    const safeName = posixPath.basename(fileName).trim();
    const normalizedCwd = remoteCwd?.trim() || "/";

    if (!safeName) {
      throw new Error("Invalid target file name.");
    }

    return posixPath.join(normalizedCwd, safeName);
  }

  /**
   * Gets the preferred local shell executable path.
   *
   * Priority:
   * 1) `$SHELL` if it exists on disk
   * 2) `/bin/bash` if available
   * 3) fallback `/bin/sh`
   *
   * @returns Absolute shell executable path.
   *
   * @example
   * const shell = PathManager.getPreferredLocalShellPath();
   * // => "/bin/zsh" (if SHELL=/bin/zsh and file exists)
   */
  static getPreferredLocalShellPath(): string {
    const preferredShell = process.env.SHELL;

    if (preferredShell && existsSync(preferredShell)) {
      return preferredShell;
    }

    if (existsSync("/bin/bash")) {
      return "/bin/bash";
    }

    return "/bin/sh";
  }

  /**
   * Updates tracked remote cwd from a submitted command line.
   *
   * Supported forms:
   * - `cd`
   * - `cd ~`
   * - `cd ~/path`
   * - `cd /absolute/path`
   * - `cd relative/path`
   *
   * @param session Mutable terminal session shape.
   * @param commandLine One command line, usually captured on Enter.
   */
  static applyCdCommandToTrackedCwd(
    session: TerminalSessionShape,
    commandLine: string,
  ): void {
    const trimmed = commandLine.trim();
    if (!trimmed) {
      return;
    }

    const firstSegment = trimmed.split(/&&|\|\||;/)[0]?.trim() ?? "";
    const cdMatch = /^cd(?:\s+(.+))?$/.exec(firstSegment);
    if (!cdMatch) {
      return;
    }

    const rawTarget = (cdMatch[1] ?? "").trim();
    if (!rawTarget || rawTarget === "~") {
      session.remoteCwd = session.remoteHomeDir || "/";
      return;
    }

    if (rawTarget === "-") {
      return;
    }

    const targetDir = PathManager.stripWrappingQuotes(rawTarget);
    if (!targetDir) {
      return;
    }

    if (targetDir === "~") {
      session.remoteCwd = session.remoteHomeDir || "/";
      return;
    }

    if (targetDir.startsWith("~/")) {
      const suffix = targetDir.slice(2);
      session.remoteCwd = posixPath.normalize(
        posixPath.join(session.remoteHomeDir || "/", suffix),
      );
      return;
    }

    if (targetDir.startsWith("/")) {
      session.remoteCwd = posixPath.normalize(targetDir);
      return;
    }

    session.remoteCwd = posixPath.normalize(
      posixPath.join(session.remoteCwd || "/", targetDir),
    );
  }

  /**
   * Detects current remote working directory for an SSH client session.
   *
   * Runs `pwd` on a remote exec channel.
   *
   * @param client Connected SSH client.
   * @returns Absolute remote cwd or `undefined` if not available.
   *
   * @example
   * const cwd = await PathManager.getRemoteWorkingDirectory(client);
   * // => "/home/michal/projects" | undefined
   */
  static async getRemoteWorkingDirectory(
    client: Client,
  ): Promise<string | undefined> {
    return await new Promise((resolve) => {
      client.exec("pwd", (err: Error | undefined, channel: any) => {
        if (err || !channel) {
          resolve(undefined);
          return;
        }

        const chunks: Buffer[] = [];
        channel.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
        });

        channel.on("close", (code?: number) => {
          if (typeof code === "number" && code !== 0) {
            resolve(undefined);
            return;
          }

          const cwd = Buffer.concat(chunks).toString("utf-8").trim();
          resolve(cwd || undefined);
        });
      });
    });
  }

  /**
   * Detects remote home directory for an SSH client session.
   *
   * Uses `$HOME` from a non-interactive shell context.
   *
   * @param client Connected SSH client.
   * @returns Remote home directory or `undefined` on failure.
   *
   * @example
   * const home = await PathManager.getRemoteHomeDirectory(client);
   * // => "/home/michal" | undefined
   */
  static async getRemoteHomeDirectory(
    client: Client,
  ): Promise<string | undefined> {
    return await new Promise((resolve) => {
      client.exec(
        'printf "%s" "$HOME"',
        (err: Error | undefined, channel: any) => {
          if (err || !channel) {
            resolve(undefined);
            return;
          }

          const chunks: Buffer[] = [];
          channel.on("data", (chunk: Buffer) => {
            chunks.push(Buffer.from(chunk));
          });

          channel.on("close", (code?: number) => {
            if (typeof code === "number" && code !== 0) {
              resolve(undefined);
              return;
            }

            const homeDir = Buffer.concat(chunks).toString("utf-8").trim();
            resolve(homeDir || undefined);
          });
        },
      );
    });
  }

  /**
   * Checks whether a remote path exists and is a directory.
   *
   * @param client Connected SSH client.
   * @param remoteDir Absolute or shell-resolvable directory path.
   * @returns `true` when directory exists; otherwise `false`.
   *
   * @example
   * const ok = await PathManager.isRemoteDirectory(client, "/var/log");
   * // => true | false
   */
  static async isRemoteDirectory(
    client: Client,
    remoteDir: string,
  ): Promise<boolean> {
    return await new Promise((resolve) => {
      const command = `test -d ${PathManager.quoteForShellArgument(remoteDir)} && printf ok || true`;
      client.exec(command, (err: Error | undefined, channel: any) => {
        if (err || !channel) {
          resolve(false);
          return;
        }

        const out: Buffer[] = [];
        channel.on("data", (chunk: Buffer) => {
          out.push(Buffer.from(chunk));
        });

        channel.on("close", () => {
          const text = Buffer.concat(out).toString("utf-8").trim();
          resolve(text === "ok");
        });
      });
    });
  }

  /**
   * Tracks remote working directory state from interactive shell input.
   *
   * This parser is lightweight and intentionally focuses on `cd` commands.
   * It handles:
   * - plain `cd`
   * - `cd /absolute/path`
   * - `cd relative/path`
   * - `cd ~` and `cd ~/path`
   * - command separators (`&&`, `||`, `;`) by reading first segment only
   * - basic escape-sequence skipping (arrow keys, CSI/SS3)
   *
   * @param session Mutable session state containing cwd and line buffer.
   * @param input Raw interactive input bytes sent to shell.
   *
   * @example
   * PathManager.trackRemoteCwdFromInput(session, "cd ~/Videos\r");
   * // session.remoteCwd becomes "/home/user/Videos"
   */
  static trackRemoteCwdFromInput(
    session: TerminalSessionShape,
    input: string,
  ): void {
    for (const char of input) {
      if (session.inEscapeSequence) {
        // CSI/SS3 escape sequences end with a final byte in range 0x40-0x7E.
        if (/[@-~]/.test(char)) {
          session.inEscapeSequence = false;
        }
        continue;
      }

      if (char === "\u001b") {
        session.inEscapeSequence = true;
        continue;
      }

      if (char === "\b" || char === "\u007f") {
        session.inputLineBuffer = session.inputLineBuffer.slice(0, -1);
        continue;
      }

      if (char === "\r" || char === "\n") {
        PathManager.applyCdCommandToTrackedCwd(
          session,
          session.inputLineBuffer,
        );
        session.inputLineBuffer = "";
        continue;
      }

      if (char >= " ") {
        session.inputLineBuffer += char;
      }
    }
  }
}

/**
 * Normalizes output line endings to CRLF for terminal rendering.
 *
 * xterm expects `\r\n` for predictable new lines. This helper converts
 * plain `\n` and mixed endings to `\r\n`.
 *
 * @param text Raw output chunk from PTY/SSH stream.
 * @returns Output safe to write into terminal UI.
 *
 * @example
 * normalizeTerminalOutputLineEndings("a\nb")
 * // => "a\r\nb"
 */
export function normalizeTerminalOutputLineEndings(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * Returns process environment variables as a strict string-to-string map.
 *
 * Useful for APIs like `node-pty` that expect environment values to be
 * strings only.
 *
 * @returns A filtered copy of `process.env` with only string values.
 *
 * @example
 * const env = getProcessEnvironmentAsStrings();
 * // env.PATH is guaranteed to be string when present
 */
export function getProcessEnvironmentAsStrings(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
