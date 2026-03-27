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
import { downloadRemoteFile, uploadRemoteFile } from "./scp-transfer.js";
import type {
  TerminalConnection,
  TerminalForLocal,
  TerminalForSsh,
} from "./ssh-terminal-bridge.js";

type SendTerminalOutput = (terminalId: string, text: string) => void;

type EditorCommand = {
  command: string;
  args: string[];
};

type SshCommanderSession = {
  client: Client;
  isReady: boolean;
  remoteCwd: string;
};

type SshCommanderDependencies = {
  ensureTerminalConnected: (
    terminal: TerminalConnection,
    sendOutput: SendTerminalOutput,
  ) => Promise<void>;
  getSession: (terminalId: string) => SshCommanderSession | undefined;
  isLocalTerminal: (
    terminal: TerminalConnection,
  ) => terminal is TerminalForLocal;
};

function getCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  let prefix = values[0] ?? "";
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i] ?? "";
    let j = 0;
    while (j < prefix.length && j < value.length && prefix[j] === value[j]) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) {
      break;
    }
  }

  return prefix;
}

function shellSplit(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

function parseSshCommanderArguments(commandLine: string): string[] {
  return shellSplit(commandLine);
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function resolveConfiguredEditorCommand(): EditorCommand | undefined {
  const configured = (
    process.env.SSH_COMMANDER_EDITOR ||
    process.env.EDITOR ||
    process.env.VISUAL ||
    ""
  ).trim();

  if (!configured) {
    return undefined;
  }

  const parts = shellSplit(configured);
  if (parts.length === 0) {
    return undefined;
  }

  const [command, ...args] = parts;
  return { command: command!, args };
}

function commandExists(command: string): boolean {
  const check = spawnSync("sh", [
    "-lc",
    `command -v ${escapeShellArg(command)} >/dev/null 2>&1`,
  ]);
  return check.status === 0;
}

function shouldRunEditorInTerminal(editor: EditorCommand): boolean {
  const force = (process.env.SSH_COMMANDER_EDITOR_IN_TERMINAL || "")
    .trim()
    .toLowerCase();
  if (force === "1" || force === "true" || force === "yes") {
    return true;
  }

  const terminalEditors = new Set([
    "nano",
    "vim",
    "nvim",
    "hx",
    "helix",
    "kak",
    "emacs",
    "vi",
  ]);
  return terminalEditors.has(editor.command);
}

function resolveTerminalLauncher(): string | undefined {
  const candidates = [
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
    "kitty",
    "alacritty",
  ];
  return candidates.find((candidate) => commandExists(candidate));
}

async function openFileWithConfiguredEditor(
  editor: EditorCommand,
  filePath: string,
): Promise<void> {
  if (shouldRunEditorInTerminal(editor)) {
    const terminalLauncher = resolveTerminalLauncher();
    if (!terminalLauncher) {
      throw new Error(
        "No terminal emulator found to run terminal editor. Install x-terminal-emulator/gnome-terminal/xterm or set SSH_COMMANDER_EDITOR_IN_TERMINAL=false.",
      );
    }

    const editorCommand = [editor.command, ...editor.args, filePath]
      .map((part) => escapeShellArg(part))
      .join(" ");

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        terminalLauncher,
        ["-e", "sh", "-lc", editorCommand],
        {
          stdio: "ignore",
          detached: false,
        },
      );

      child.on("error", reject);
      child.on("exit", () => resolve());
    });

    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor.command, [...editor.args, filePath], {
      stdio: "ignore",
      detached: false,
    });

    child.on("error", reject);
    child.on("exit", () => resolve());
  });
}

async function openFileWithSystemEditor(filePath: string): Promise<void> {
  await open(filePath, { wait: true });
}

function resolveRemotePath(baseCwd: string, relativePath: string): string {
  if (relativePath.startsWith("/")) {
    return relativePath;
  }

  if (baseCwd.endsWith("/")) {
    return baseCwd + relativePath;
  }

  return baseCwd + "/" + relativePath;
}

function normalizeRemotePath(inputPath: string): string {
  return inputPath.trim();
}

function execCapture(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
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

export async function completeSshCommanderEditCommand(
  terminal: TerminalConnection,
  commandLine: string,
  deps: SshCommanderDependencies,
): Promise<string | undefined> {
  if (deps.isLocalTerminal(terminal)) {
    return undefined;
  }

  const lineStart = commandLine.replace(/^\s+/, "");
  if (!lineStart.startsWith("sshCommander")) {
    return undefined;
  }

  if (!/^sshCommander\s+edit(?:\s+.*)?$/.test(lineStart)) {
    return undefined;
  }

  await deps.ensureTerminalConnected(terminal, () => {
    // no-op output for completion
  });

  const session = deps.getSession(terminal.id);
  if (!session?.isReady) {
    return undefined;
  }

  const editPartMatch = /^sshCommander\s+edit\s*(.*)$/.exec(lineStart);
  const rawInput = (editPartMatch?.[1] ?? "").trimStart();

  const typedPath = rawInput;
  const resolved = resolveRemotePath(session.remoteCwd, typedPath || "");

  const slashIndex = resolved.lastIndexOf("/");
  const parentDir =
    slashIndex >= 0
      ? resolved.slice(0, slashIndex + 1)
      : `${session.remoteCwd.replace(/\/?$/, "/")}`;
  const partialName =
    slashIndex >= 0 ? resolved.slice(slashIndex + 1) : resolved;

  const listOutput = await execCapture(
    session.client,
    `ls -1Ap -- ${escapeShellArg(parentDir)} 2>/dev/null || true`,
  );

  const entries = listOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => entry.startsWith(partialName));

  if (entries.length === 0) {
    return undefined;
  }

  const typedDirPart = typedPath.includes("/")
    ? typedPath.slice(0, typedPath.lastIndexOf("/") + 1)
    : "";

  if (entries.length === 1) {
    const completed = entries[0] ?? "";
    return `sshCommander edit ${typedDirPart}${completed}`;
  }

  const commonPrefix = getCommonPrefix(entries);
  if (!commonPrefix || commonPrefix === partialName) {
    return undefined;
  }

  return `sshCommander edit ${typedDirPart}${commonPrefix}`;
}

async function runSshCommanderEdit(
  terminal: TerminalForSsh,
  remotePath: string,
  sendOutput: SendTerminalOutput,
  deps: SshCommanderDependencies,
) {
  console.log("[sshCommander edit] Start", {
    terminalId: terminal.id,
    remotePath,
  });

  await deps.ensureTerminalConnected(terminal, sendOutput);

  const session = deps.getSession(terminal.id);
  if (!session?.isReady) {
    console.log("[sshCommander edit] Session not ready", {
      terminalId: terminal.id,
    });
    sendOutput(terminal.id, "[sshCommander error] SSH session is not ready.");
    return;
  }

  const resolvedPath = resolveRemotePath(session.remoteCwd, remotePath);
  const remotePathNormalized = normalizeRemotePath(resolvedPath);
  console.log("[sshCommander edit] Resolved path", {
    terminalId: terminal.id,
    remoteCwd: session.remoteCwd,
    requestedPath: remotePath,
    resolvedPath,
    remotePathNormalized,
  });
  if (!remotePathNormalized) {
    sendOutput(
      terminal.id,
      "[sshCommander error] Missing target file path. Usage: sshCommander edit <path_to_file>",
    );
    return;
  }

  const cacheRoot = path.join(os.tmpdir(), "sshCommander-cache", terminal.id);
  mkdirSync(cacheRoot, { recursive: true });

  const safeName = remotePathNormalized.replace(/[\\/]+/g, "__");
  const cachePath = path.join(cacheRoot, safeName || "remote_file");
  console.log("[sshCommander edit] Cache file", {
    terminalId: terminal.id,
    cachePath,
  });

  const remoteBuffer = await downloadRemoteFile(
    session.client,
    remotePathNormalized,
  );
  console.log("[sshCommander edit] Download finished", {
    terminalId: terminal.id,
    remotePathNormalized,
    bytes: remoteBuffer.length,
  });
  writeFileSync(cachePath, remoteBuffer);

  sendOutput(
    terminal.id,
    `[sshCommander] Downloaded ${remotePathNormalized} to ${cachePath}\r\n`,
  );

  let lastUploadedBuffer = Buffer.from(remoteBuffer);

  const pushBackIfChanged = async (reason: string): Promise<boolean> => {
    const stats = statSync(cachePath);
    const mtimeMs = stats.mtimeMs;

    const updatedBuffer = readFileSync(cachePath);
    if (updatedBuffer.equals(lastUploadedBuffer)) {
      console.log("[sshCommander edit] No changes detected", {
        terminalId: terminal.id,
        remotePathNormalized,
        reason,
      });
      return false;
    }

    await uploadRemoteFile(session.client, remotePathNormalized, updatedBuffer);
    console.log("[sshCommander edit] Upload-back finished", {
      terminalId: terminal.id,
      remotePathNormalized,
      reason,
      bytes: updatedBuffer.length,
    });
    lastUploadedBuffer = Buffer.from(updatedBuffer);

    sendOutput(
      terminal.id,
      `[sshCommander] Uploaded updated file (${reason}) → ${remotePathNormalized} [mtime ${mtimeMs}]\r\n`,
    );

    return true;
  };

  let watcher: FSWatcher | undefined;
  let syncTimer: NodeJS.Timeout | undefined;

  try {
    watcher = watch(cachePath, { persistent: false }, () => {
      console.log("[sshCommander edit] Local cache file changed", {
        terminalId: terminal.id,
        cachePath,
      });
      if (syncTimer) {
        clearTimeout(syncTimer);
      }

      syncTimer = setTimeout(() => {
        pushBackIfChanged("save").catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Unknown upload error";
          sendOutput(terminal.id, `[sshCommander error] ${message}`);
        });
      }, 400);
    });
    console.log("[sshCommander edit] File watcher active", {
      terminalId: terminal.id,
      cachePath,
    });
  } catch {
    console.log("[sshCommander edit] Failed to start file watcher", {
      terminalId: terminal.id,
      cachePath,
    });
  }

  const configuredEditor = resolveConfiguredEditorCommand();
  if (configuredEditor) {
    console.log("[sshCommander edit] Opening configured editor", {
      terminalId: terminal.id,
      editor: configuredEditor.command,
    });
    sendOutput(
      terminal.id,
      `[sshCommander] Opening with configured editor: ${configuredEditor.command}\r\n`,
    );
    await openFileWithConfiguredEditor(configuredEditor, cachePath);
  } else {
    console.log("[sshCommander edit] Opening system editor", {
      terminalId: terminal.id,
    });
    sendOutput(
      terminal.id,
      "[sshCommander] No configured editor in .env. Opening with system default app.\r\n",
    );
    await openFileWithSystemEditor(cachePath);
  }

  if (syncTimer) {
    clearTimeout(syncTimer);
    await pushBackIfChanged("save");
  }

  watcher?.close();
  console.log("[sshCommander edit] Completed", {
    terminalId: terminal.id,
    remotePathNormalized,
  });
}

export async function handleSshCommanderEditCommand(
  terminal: TerminalConnection,
  commandLine: string,
  sendOutput: SendTerminalOutput,
  deps: SshCommanderDependencies,
): Promise<void> {
  console.log("[sshCommander] Incoming command", {
    terminalId: terminal.id,
    commandLine,
  });
  const args = parseSshCommanderArguments(commandLine);
  if (args[0] !== "sshCommander") {
    return;
  }

  if (args.length === 1 || args.includes("-h") || args.includes("--help")) {
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
    await runSshCommanderEdit(terminal, remotePath, sendOutput, deps);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown sshCommander error";
    sendOutput(terminal.id, `[sshCommander error] ${message}`);
  }
}
