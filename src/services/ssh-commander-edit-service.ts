import {
  mkdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { type Client } from "ssh2";
import open from "open";
import { ScpTransfer } from "./remote-file-transfer-manager.js";
import { PathManager } from "./ssh-runtime-utils.js";
import type {
  TerminalConnection,
  TerminalForLocal,
  TerminalForSsh,
} from "../types/terminal.js";

const scpTransfer = new ScpTransfer();

export type SendTerminalOutput = (terminalId: string, text: string) => void;

type EditorCommand = {
  command: string;
  args: string[];
};

export type SshCommanderSession = {
  client: Client;
  isReady: boolean;
  remoteCwd: string;
};

export type SshCommanderEditDependencies = {
  ensureTerminalConnected: (
    terminal: TerminalConnection,
    sendOutput: SendTerminalOutput,
  ) => Promise<void>;
  getSession: (terminalId: string) => SshCommanderSession | undefined;
  isLocalTerminal: (
    terminal: TerminalConnection,
  ) => terminal is TerminalForLocal;
};

/**
 * Parses and validates sshCommander command lines.
 */
class SshCommanderCommandParser {
  /**
   * Splits a command line into shell-like tokens.
   *
   * Quotes are preserved for grouping and then removed from token edges.
   *
   * @param commandLine Raw command line input.
   * @returns Parsed argument tokens.
   */
  parseTokens(commandLine: string): string[] {
    const matches = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
  }

  /**
   * Checks whether line content is an `sshCommander edit` completion target.
   *
   * @param commandLine Raw command line input.
   * @returns `true` when completion logic should run.
   */
  isEditCompletionRequest(commandLine: string): boolean {
    const lineStart = commandLine.replace(/^\s+/, "");
    return Boolean(
      lineStart.startsWith("sshCommander") &&
      /^sshCommander\s+edit(?:\s+.*)?$/.test(lineStart),
    );
  }

  /**
   * Extracts the currently typed path part from `sshCommander edit ...`.
   *
   * @param commandLine Raw command line input.
   * @returns Path fragment after `sshCommander edit`.
   */
  extractCompletionTypedPath(commandLine: string): string {
    const lineStart = commandLine.replace(/^\s+/, "");
    const match = /^sshCommander\s+edit\s*(.*)$/.exec(lineStart);
    return (match?.[1] ?? "").trimStart();
  }

  /**
   * Determines whether command args request help output.
   *
   * @param args Parsed command arguments.
   * @returns `true` when help should be shown.
   */
  isHelpRequested(args: string[]): boolean {
    return args.length === 1 || args.includes("-h") || args.includes("--help");
  }
}

/**
 * Handles local editor launch strategy for cached remote files.
 *
 * This class resolves editor configuration from environment variables,
 * chooses between configured-editor mode and system-default mode, and
 * transparently wraps terminal-based editors in an available terminal
 * emulator when needed.
 */
class OpenEditorHandler {
  private static readonly terminalEditors = new Set([
    "nano",
    "vim",
    "nvim",
    "hx",
    "helix",
    "kak",
    "emacs",
    "vi",
  ]);

  /**
   * Opens a file using configured editor or system default app.
   *
   * @param cachePath Local cached file path to open.
   * @returns Launch mode metadata with optional configured editor name.
   */
  async openFile(
    cachePath: string,
  ): Promise<{ mode: "configured" | "system"; editor?: string }> {
    const configured = this.resolveConfiguredEditorCommand();

    if (!configured) {
      await open(cachePath, { wait: true });
      return { mode: "system" };
    }

    await this.openFileWithConfiguredEditor(configured, cachePath);
    return { mode: "configured", editor: configured.command };
  }

  /**
   * Resolves configured editor command from environment variables.
   *
   * @returns Parsed editor command or `undefined` when not configured.
   */
  private resolveConfiguredEditorCommand(): EditorCommand | undefined {
    const configured = (
      process.env.SSH_COMMANDER_EDITOR ||
      process.env.EDITOR ||
      process.env.VISUAL ||
      ""
    ).trim();

    if (!configured) {
      return undefined;
    }

    const parts = new SshCommanderCommandParser().parseTokens(configured);
    if (parts.length === 0) {
      return undefined;
    }

    const [command, ...args] = parts;
    return { command: command!, args };
  }

  /**
   * Checks whether a command exists on PATH.
   *
   * @param command Command name to check.
   * @returns `true` when command is available.
   */
  private commandExists(command: string): boolean {
    const check = spawnSync("sh", [
      "-lc",
      `command -v ${PathManager.quoteForShellArgument(command)} >/dev/null 2>&1`,
    ]);
    return check.status === 0;
  }

  /**
   * Finds an installed terminal launcher command.
   *
   * @returns Terminal launcher binary name or `undefined`.
   */
  private resolveTerminalLauncher(): string | undefined {
    const candidates = [
      "x-terminal-emulator",
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "xterm",
      "kitty",
      "alacritty",
    ];

    return candidates.find((candidate) => this.commandExists(candidate));
  }

  /**
   * Determines whether editor should run inside a terminal emulator.
   *
   * @param editor Parsed editor command.
   * @returns `true` when terminal launch is required.
   */
  private shouldRunEditorInTerminal(editor: EditorCommand): boolean {
    const force = (process.env.SSH_COMMANDER_EDITOR_IN_TERMINAL || "")
      .trim()
      .toLowerCase();

    if (force === "1" || force === "true" || force === "yes") {
      return true;
    }

    return OpenEditorHandler.terminalEditors.has(editor.command);
  }

  /**
   * Opens a file with a configured editor command.
   *
   * Launches directly for GUI editors; wraps terminal editors in an available
   * terminal emulator command.
   *
   * @param editor Parsed editor command.
   * @param filePath File path to open.
   */
  private async openFileWithConfiguredEditor(
    editor: EditorCommand,
    filePath: string,
  ): Promise<void> {
    if (!this.shouldRunEditorInTerminal(editor)) {
      await this.spawnAndWait(editor.command, [...editor.args, filePath]);
      return;
    }

    const terminalLauncher = this.resolveTerminalLauncher();
    if (!terminalLauncher) {
      throw new Error(
        "No terminal emulator found to run terminal editor. Install x-terminal-emulator/gnome-terminal/xterm or set SSH_COMMANDER_EDITOR_IN_TERMINAL=false.",
      );
    }

    const editorCommand = [editor.command, ...editor.args, filePath]
      .map((part) => PathManager.quoteForShellArgument(part))
      .join(" ");

    await this.spawnAndWait(terminalLauncher, [
      "-e",
      "sh",
      "-lc",
      editorCommand,
    ]);
  }

  /**
   * Spawns a process and waits until it exits.
   *
   * @param command Executable name.
   * @param args Process arguments.
   */
  private async spawnAndWait(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: false,
      });

      child.on("error", reject);
      child.on("exit", () => resolve());
    });
  }
}

/**
 * Provides remote path auto-completion for `sshCommander edit`.
 *
 * The completion flow resolves user input against the SSH session cwd,
 * lists matching entries from the remote filesystem, and returns either
 * the single matching result or a shared prefix for multiple matches.
 */
class RemoteAutoCompletion {
  /**
   * Returns the longest common prefix from a set of candidate names.
   *
   * @param values Candidate completion entries.
   * @returns Shared prefix or empty string when no shared prefix exists.
   */
  private getCommonPrefix(values: string[]): string {
    if (values.length === 0) {
      return "";
    }

    let prefix = values[0] ?? "";
    for (let index = 1; index < values.length; index += 1) {
      const value = values[index] ?? "";
      let charIndex = 0;
      while (
        charIndex < prefix.length &&
        charIndex < value.length &&
        prefix[charIndex] === value[charIndex]
      ) {
        charIndex += 1;
      }
      prefix = prefix.slice(0, charIndex);
      if (!prefix) {
        break;
      }
    }

    return prefix;
  }

  /**
   * Executes a remote command and captures stdout as UTF-8 text.
   *
   * Rejects when SSH execution fails, or when the command exits with a
   * non-zero code and stderr content.
   *
   * @param client Active SSH client.
   * @param command Shell command to execute remotely.
   * @returns Captured stdout text.
   */
  private async executeCommandToText(
    client: Client,
    command: string,
  ): Promise<string> {
    return await new Promise((resolve, reject) => {
      client.exec(command, (err: Error | undefined, channel: any) => {
        if (err || !channel) {
          reject(err ?? new Error("Failed to run remote command."));
          return;
        }

        const out: Buffer[] = [];
        let errText = "";

        channel.on("data", (chunk: Buffer) => {
          out.push(Buffer.from(chunk));
        });

        channel.stderr?.on("data", (chunk: Buffer) => {
          errText += chunk.toString("utf-8");
        });

        channel.on("close", (code?: number) => {
          if (typeof code === "number" && code !== 0 && errText.trim()) {
            reject(new Error(errText.trim()));
            return;
          }

          resolve(Buffer.concat(out).toString("utf-8"));
        });
      });
    });
  }

  /**
   * Produces a best-effort completion value for `sshCommander edit <path>`.
   *
   * Resolves the typed path against the session cwd, lists the parent
   * directory remotely, and returns either a full single match or a shared
   * common prefix for multiple matches.
   *
   * @param session Active SSH session metadata.
   * @param typedPath Raw path fragment currently typed by the user.
   * @returns Completed path fragment or `undefined` if no completion is found.
   */
  async completeEditPath(
    session: SshCommanderSession,
    typedPath: string,
  ): Promise<string | undefined> {
    const pathInput = typedPath || "";
    const resolvedPath = pathInput.startsWith("/")
      ? pathInput
      : session.remoteCwd.endsWith("/")
        ? `${session.remoteCwd}${pathInput}`
        : `${session.remoteCwd}/${pathInput}`;

    const slashIndex = resolvedPath.lastIndexOf("/");
    const parentDir =
      slashIndex >= 0
        ? resolvedPath.slice(0, slashIndex + 1)
        : `${session.remoteCwd.replace(/\/?$/, "/")}`;
    const partialName =
      slashIndex >= 0 ? resolvedPath.slice(slashIndex + 1) : resolvedPath;

    const listOutput = await this.executeCommandToText(
      session.client,
      `ls -1Ap -- ${PathManager.quoteForShellArgument(parentDir)} 2>/dev/null || true`,
    );

    const matches = listOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((entry) => entry.startsWith(partialName));

    if (matches.length === 0) {
      return undefined;
    }

    const typedDirPart = typedPath.includes("/")
      ? typedPath.slice(0, typedPath.lastIndexOf("/") + 1)
      : "";

    if (matches.length === 1) {
      return `${typedDirPart}${matches[0]}`;
    }

    const commonPrefix = this.getCommonPrefix(matches);
    if (!commonPrefix || commonPrefix === partialName) {
      return undefined;
    }

    return `${typedDirPart}${commonPrefix}`;
  }
}

/**
 * Coordinates `sshCommander edit` command lifecycle.
 *
 * Responsibilities:
 * - Parse and route `sshCommander` command lines.
 * - Provide tab-completion for `sshCommander edit <path>`.
 * - Execute remote edit flow (download → open local editor → upload on save).
 * - Emit user-facing status and error output to the terminal.
 */
export class SshCommanderEditHandler {
  private readonly parser = new SshCommanderCommandParser();
  private readonly completion = new RemoteAutoCompletion();
  private readonly editorLauncher = new OpenEditorHandler();

  /**
   * Executes the remote edit workflow for a single target path.
   *
   * Flow:
   * 1) Ensure SSH terminal session is connected and ready.
   * 2) Resolve and validate remote path.
   * 3) Download remote file into local cache.
   * 4) Open cached file in local editor.
   * 5) Watch file changes and upload updates back to remote host.
   *
   * @param terminal SSH terminal context.
   * @param remotePath Path provided after `sshCommander edit`.
   * @param sendOutput Terminal output callback.
   * @param deps Runtime dependencies for session and terminal state.
   */
  private async editRemotePathWithLocalSync(
    terminal: TerminalForSsh,
    remotePath: string,
    sendOutput: SendTerminalOutput,
    deps: SshCommanderEditDependencies,
  ): Promise<void> {
    console.log("[sshCommander edit] Start", {
      terminalId: terminal.id,
      remotePath,
    });

    await deps.ensureTerminalConnected(terminal, sendOutput);

    const session = deps.getSession(terminal.id);
    if (!session?.isReady) {
      sendOutput(terminal.id, "[sshCommander error] SSH session is not ready.");
      return;
    }

    const resolvedPath = (
      remotePath.startsWith("/")
        ? remotePath
        : session.remoteCwd.endsWith("/")
          ? `${session.remoteCwd}${remotePath}`
          : `${session.remoteCwd}/${remotePath}`
    ).trim();
    if (!resolvedPath) {
      sendOutput(
        terminal.id,
        "[sshCommander error] Missing target file path. Usage: sshCommander edit <path_to_file>",
      );
      return;
    }

    const cacheRoot = path.join(os.tmpdir(), "sshCommander-cache", terminal.id);
    mkdirSync(cacheRoot, { recursive: true });

    const cachePath = path.join(
      cacheRoot,
      resolvedPath.replace(/[\\/]+/g, "__") || "remote_file",
    );

    const originalBuffer = await scpTransfer.downloadRemoteFile(
      session.client,
      resolvedPath,
    );
    writeFileSync(cachePath, originalBuffer);

    sendOutput(
      terminal.id,
      `[sshCommander] Downloaded ${resolvedPath} to ${cachePath}\r\n`,
    );

    let lastUploadedBuffer = Buffer.from(originalBuffer);

    const uploadIfChanged = async (reason: string): Promise<boolean> => {
      const stats = statSync(cachePath);
      const updatedBuffer = readFileSync(cachePath);

      if (updatedBuffer.equals(lastUploadedBuffer)) {
        return false;
      }

      await scpTransfer.uploadRemoteFile(
        session.client,
        resolvedPath,
        updatedBuffer,
      );
      lastUploadedBuffer = Buffer.from(updatedBuffer);

      sendOutput(
        terminal.id,
        `[sshCommander] Uploaded updated file (${reason}) → ${resolvedPath} [mtime ${stats.mtimeMs}]\r\n`,
      );

      return true;
    };

    let watcher: FSWatcher | undefined;
    let syncTimer: NodeJS.Timeout | undefined;

    try {
      watcher = watch(cachePath, { persistent: false }, () => {
        if (syncTimer) {
          clearTimeout(syncTimer);
        }

        syncTimer = setTimeout(() => {
          uploadIfChanged("save").catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : "Unknown upload error";
            sendOutput(terminal.id, `[sshCommander error] ${message}`);
          });
        }, 400);
      });
    } catch {
      // no-op, workflow still works without watcher.
    }

    const launch = await this.editorLauncher.openFile(cachePath);
    if (launch.mode === "configured") {
      sendOutput(
        terminal.id,
        `[sshCommander] Opening with configured editor: ${launch.editor}\r\n`,
      );
    } else {
      sendOutput(
        terminal.id,
        "[sshCommander] No configured editor in .env. Opening with system default app.\r\n",
      );
    }

    if (syncTimer) {
      clearTimeout(syncTimer);
      await uploadIfChanged("save");
    }

    watcher?.close();
  }

  /**
   * Computes shell completion for `sshCommander edit` command lines.
   *
   * Returns a full replacement command when completion is available,
   * otherwise `undefined`.
   *
   * @param terminal Terminal where completion was requested.
   * @param commandLine Raw command line to complete.
   * @param deps Runtime dependencies for session and terminal state.
   * @returns Completed `sshCommander edit ...` command or `undefined`.
   */
  async completeEditCommand(
    terminal: TerminalConnection,
    commandLine: string,
    deps: SshCommanderEditDependencies,
  ): Promise<string | undefined> {
    if (deps.isLocalTerminal(terminal)) {
      return undefined;
    }

    if (!this.parser.isEditCompletionRequest(commandLine)) {
      return undefined;
    }

    await deps.ensureTerminalConnected(terminal, () => {
      // no-op output for completion.
    });

    const session = deps.getSession(terminal.id);
    if (!session?.isReady) {
      return undefined;
    }

    const typedPath = this.parser.extractCompletionTypedPath(commandLine);
    const completed = await this.completion.completeEditPath(
      session,
      typedPath,
    );
    return completed ? `sshCommander edit ${completed}` : undefined;
  }

  /**
   * Handles incoming `sshCommander` command lines.
   *
   * Validates command structure, prints help and error messages, and delegates
   * `edit` execution to the internal remote edit workflow.
   *
   * @param terminal Terminal issuing the command.
   * @param commandLine Raw command line input.
   * @param sendOutput Terminal output callback.
   * @param deps Runtime dependencies for session and terminal state.
   */
  async handleEditCommand(
    terminal: TerminalConnection,
    commandLine: string,
    sendOutput: SendTerminalOutput,
    deps: SshCommanderEditDependencies,
  ): Promise<void> {
    console.log("[sshCommander] Incoming command", {
      terminalId: terminal.id,
      commandLine,
    });

    const args = this.parser.parseTokens(commandLine);
    if (args[0] !== "sshCommander") {
      return;
    }

    if (this.parser.isHelpRequested(args)) {
      sendOutput(
        terminal.id,
        "[sshCommander]\r\nUsage:\r\n  sshCommander [--help|-h]\r\n  sshCommander edit <path_to_file>\r\n\r\nDescription:\r\n  edit: downloads remote file to local cache, opens local editor, uploads file back on save.\r\n",
      );
      return;
    }

    const subcommand = args[1];
    if (subcommand !== "edit") {
      sendOutput(
        terminal.id,
        `[sshCommander error] Unknown subcommand: ${subcommand}. Try sshCommander --help`,
      );
      return;
    }

    if (deps.isLocalTerminal(terminal)) {
      sendOutput(
        terminal.id,
        "[sshCommander error] `sshCommander edit` is supported only for SSH terminals.",
      );
      return;
    }

    const remotePath = args[2];
    if (!remotePath) {
      sendOutput(
        terminal.id,
        "[sshCommander error] Missing path. Usage: sshCommander edit <path_to_file>",
      );
      return;
    }

    try {
      await this.editRemotePathWithLocalSync(
        terminal,
        remotePath,
        sendOutput,
        deps,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown sshCommander error";
      sendOutput(terminal.id, `[sshCommander error] ${message}`);
    }
  }
}
