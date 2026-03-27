import { Client, type ConnectConfig } from "ssh2";
import { spawn as ptySpawn, type IPty } from "node-pty";
import {
  completeSshCommanderEditCommand,
  handleSshCommanderEditCommand,
} from "./ssh-commander-edit.js";
import type { SendTerminalOutput } from "./services/ssh-commander-edit-service.js";
import { ScpTransfer } from "./services/remote-file-transfer-manager.js";
import {
  PathManager,
  getProcessEnvironmentAsStrings,
  normalizeTerminalOutputLineEndings,
} from "./services/ssh-runtime-utils.js";
import type { TerminalConnection, TerminalForLocal } from "./types/terminal.js";
export type {
  TerminalConnection,
  TerminalForLocal,
  TerminalForSsh,
  TerminalSshConfig,
} from "./types/terminal.js";

type TerminalSession = {
  client: Client;
  stream: any | undefined;
  isReady: boolean;
  connectingPromise: Promise<void> | undefined;
  cols: number;
  rows: number;
  remoteCwd: string;
  remoteHomeDir: string;
  inputLineBuffer: string;
  inEscapeSequence: boolean;
};

type LocalTerminalSession = {
  process: IPty | undefined;
  isReady: boolean;
  connectingPromise: Promise<void> | undefined;
  cols: number;
  rows: number;
};

/**
 * In-memory store for SSH terminal sessions.
 */
class SshSessionStore {
  private readonly sessions = new Map<string, TerminalSession>();

  get(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  getOrCreate(terminalId: string): TerminalSession {
    const existing = this.sessions.get(terminalId);
    if (existing) {
      return existing;
    }

    const created: TerminalSession = {
      client: new Client(),
      stream: undefined,
      isReady: false,
      connectingPromise: undefined,
      cols: 120,
      rows: 30,
      remoteCwd: "/",
      remoteHomeDir: "/",
      inputLineBuffer: "",
      inEscapeSequence: false,
    };

    this.sessions.set(terminalId, created);
    return created;
  }

  delete(terminalId: string): boolean {
    return this.sessions.delete(terminalId);
  }
}

/**
 * In-memory store for local PTY sessions.
 */
class LocalSessionStore {
  private readonly sessions = new Map<string, LocalTerminalSession>();

  get(terminalId: string): LocalTerminalSession | undefined {
    return this.sessions.get(terminalId);
  }

  getOrCreate(terminalId: string): LocalTerminalSession {
    const existing = this.sessions.get(terminalId);
    if (existing) {
      return existing;
    }

    const created: LocalTerminalSession = {
      process: undefined,
      isReady: false,
      connectingPromise: undefined,
      cols: 120,
      rows: 30,
    };

    this.sessions.set(terminalId, created);
    return created;
  }

  delete(terminalId: string): boolean {
    return this.sessions.delete(terminalId);
  }
}

const sshSessionStore = new SshSessionStore();
const localSessionStore = new LocalSessionStore();
const scpTransfer = new ScpTransfer();

/**
 * Handles `sshCommander` command execution for a terminal.
 */
export async function handleSshCommanderCommand(
  terminal: TerminalConnection,
  commandLine: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await handleSshCommanderEditCommand(terminal, commandLine, sendOutput, {
    ensureTerminalConnected,
    getSession: (terminalId: string) => sshSessionStore.get(terminalId),
    isLocalTerminal,
  });
}

function isLocalTerminal(
  terminal: TerminalConnection,
): terminal is TerminalForLocal {
  return "type" in terminal && terminal.type === "local";
}

/**
 * Ensures a local PTY shell session is initialized and ready.
 */
async function ensureLocalTerminalConnected(
  terminal: TerminalForLocal,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  const session = localSessionStore.getOrCreate(terminal.id);

  if (session.isReady && session.process) {
    return;
  }

  if (session.connectingPromise) {
    return session.connectingPromise;
  }

  session.connectingPromise = new Promise<void>((resolve, reject) => {
    const shell = PathManager.getPreferredLocalShellPath();

    try {
      const child = ptySpawn(shell, ["-i"], {
        cwd: process.cwd(),
        env: getProcessEnvironmentAsStrings(),
        name: "xterm-256color",
        cols: session.cols,
        rows: session.rows,
      });

      session.process = child;
      session.isReady = true;
      session.connectingPromise = undefined;
      sendOutput(
        terminal.id,
        `[local] Connected to current machine shell (${shell}).\r\n`,
      );
      resolve();

      child.onData((chunk: string) => {
        sendOutput(terminal.id, normalizeTerminalOutputLineEndings(chunk));
      });

      child.onExit(({ exitCode }: { exitCode: number }) => {
        session.isReady = false;
        session.process = undefined;
        sendOutput(
          terminal.id,
          `[local] Shell process exited with code ${exitCode}.\r\n`,
        );
      });
    } catch (err) {
      session.isReady = false;
      session.process = undefined;
      session.connectingPromise = undefined;
      const message =
        err instanceof Error ? err.message : "Unknown local shell error";
      sendOutput(terminal.id, `[local error] ${message}\r\n`);
      reject(err);
    }
  });

  return session.connectingPromise;
}

/**
 * Ensures terminal connectivity for either local or SSH terminal types.
 */
export async function ensureTerminalConnected(
  terminal: TerminalConnection,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  if (isLocalTerminal(terminal)) {
    return ensureLocalTerminalConnected(terminal, sendOutput);
  }

  const session = sshSessionStore.getOrCreate(terminal.id);

  if (session.isReady && session.stream) {
    return;
  }

  if (session.connectingPromise) {
    return session.connectingPromise;
  }

  session.connectingPromise = new Promise<void>((resolve, reject) => {
    session.client.removeAllListeners();

    session.client.on("ready", () => {
      session.client.shell(
        {
          term: "xterm-256color",
          cols: session.cols,
          rows: session.rows,
        },
        (err: Error | undefined, stream: any) => {
          if (err) {
            sendOutput(
              terminal.id,
              `[ssh error] Failed to open shell: ${err.message}`,
            );
            session.isReady = false;
            session.stream = undefined;
            session.connectingPromise = undefined;
            return reject(err);
          }

          session.stream = stream;
          session.isReady = true;

          if (typeof session.stream.setWindow === "function") {
            session.stream.setWindow(session.rows, session.cols, 0, 0);
          }

          stream.on("data", (chunk: Buffer) => {
            sendOutput(
              terminal.id,
              normalizeTerminalOutputLineEndings(chunk.toString("utf-8")),
            );
          });

          PathManager.getRemoteWorkingDirectory(session.client)
            .then((cwd) => {
              if (cwd) {
                session.remoteCwd = cwd;
              }
            })
            .catch(() => {
              // no-op
            });

          PathManager.getRemoteHomeDirectory(session.client)
            .then((homeDir) => {
              if (homeDir) {
                session.remoteHomeDir = homeDir;
              }
            })
            .catch(() => {
              // no-op
            });

          stream.stderr?.on("data", (chunk: Buffer) => {
            sendOutput(
              terminal.id,
              normalizeTerminalOutputLineEndings(chunk.toString("utf-8")),
            );
          });

          stream.on("close", () => {
            session.isReady = false;
            session.stream = undefined;
            sendOutput(terminal.id, "[ssh] Shell stream closed.");
          });

          sendOutput(
            terminal.id,
            `[ssh] Connected to ${terminal.ssh.targetUser}@${terminal.ssh.targetMachine}:${terminal.ssh.targetPort}`,
          );

          session.connectingPromise = undefined;
          resolve();
        },
      );
    });

    session.client.on("error", (err: Error) => {
      sendOutput(terminal.id, `[ssh error] ${err.message}`);
      session.isReady = false;
      session.stream = undefined;
      session.connectingPromise = undefined;
      reject(err);
    });

    session.client.on("close", () => {
      session.isReady = false;
      session.stream = undefined;
      sendOutput(terminal.id, "[ssh] Connection closed.");
    });

    let connectionConfig: ConnectConfig;

    if (terminal.ssh.authMethod === "password") {
      if (!terminal.ssh.password) {
        const err = new Error("Missing SSH password for terminal.");
        sendOutput(terminal.id, `[ssh error] ${err.message}`);
        session.connectingPromise = undefined;
        return reject(err);
      }

      connectionConfig = {
        host: terminal.ssh.targetMachine,
        port: terminal.ssh.targetPort,
        username: terminal.ssh.targetUser,
        password: terminal.ssh.password,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
    } else {
      if (!terminal.ssh.sshKey) {
        const err = new Error("Missing SSH private key for terminal.");
        sendOutput(terminal.id, `[ssh error] ${err.message}`);
        session.connectingPromise = undefined;
        return reject(err);
      }

      connectionConfig = {
        host: terminal.ssh.targetMachine,
        port: terminal.ssh.targetPort,
        username: terminal.ssh.targetUser,
        privateKey: terminal.ssh.sshKey,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
      };
    }

    session.client.connect(connectionConfig);
  });

  return session.connectingPromise;
}

/**
 * Sends one command line to a terminal and appends a trailing newline.
 */
export async function sendCommandToTerminal(
  terminal: TerminalConnection,
  command: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await sendRawInputToTerminal(terminal, `${command}\n`, sendOutput);
}

/**
 * Writes raw user input bytes into a connected terminal stream.
 */
export async function sendRawInputToTerminal(
  terminal: TerminalConnection,
  input: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await ensureTerminalConnected(terminal, sendOutput);

  if (isLocalTerminal(terminal)) {
    const session = localSessionStore.get(terminal.id);
    if (!session?.process || !session.isReady) {
      sendOutput(terminal.id, "[local error] Terminal stream is not ready.");
      return;
    }

    // Keep CR/LF bytes from xterm as-is.
    // Converting Enter (\r) to \n causes cursor/prompt misalignment in zsh/bash.
    session.process.write(input);
    return;
  }

  const session = sshSessionStore.get(terminal.id);
  if (!session?.stream || !session.isReady) {
    sendOutput(terminal.id, "[ssh error] Terminal stream is not ready.");
    return;
  }

  // Track CWD changes for relative path resolution.
  PathManager.trackRemoteCwdFromInput(session, input);
  session.stream.write(input);
}

/**
 * Updates terminal dimensions for local PTY or SSH shell window.
 */
export async function resizeTerminalPty(
  terminal: TerminalConnection,
  cols: number,
  rows: number,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  if (isLocalTerminal(terminal)) {
    const session = localSessionStore.getOrCreate(terminal.id);

    session.cols = cols;
    session.rows = rows;

    if (session.process && session.isReady) {
      session.process.resize(cols, rows);
    }

    return;
  }

  const session = sshSessionStore.getOrCreate(terminal.id);

  session.cols = cols;
  session.rows = rows;

  if (!session.stream || !session.isReady) {
    return;
  }

  if (typeof session.stream.setWindow === "function") {
    session.stream.setWindow(rows, cols, 0, 0);
  }
}

/**
 * Closes and removes terminal session state for the given terminal id.
 */
export function resetTerminalConnection(terminalId: string) {
  const localSession = localSessionStore.get(terminalId);
  if (localSession) {
    localSession.process?.kill();
    localSessionStore.delete(terminalId);
  }

  const session = sshSessionStore.get(terminalId);
  if (!session) {
    return;
  }

  session.stream = undefined;
  session.isReady = false;
  session.connectingPromise = undefined;
  session.client.removeAllListeners();
  session.client.end();
  sshSessionStore.delete(terminalId);
}

/**
 * Provides command completion for `sshCommander` command lines.
 */
export async function completeSshCommanderCommand(
  terminal: TerminalConnection,
  commandLine: string,
): Promise<string | undefined> {
  return await completeSshCommanderEditCommand(terminal, commandLine, {
    ensureTerminalConnected,
    getSession: (terminalId: string) => sshSessionStore.get(terminalId),
    isLocalTerminal,
  });
}

/**
 * Uploads a dropped file into the remote current directory for SSH terminals.
 *
 * Uses tracked session cwd when valid, otherwise falls back to remote home.
 */
export async function uploadFileToTerminalCurrentDirectory(
  terminal: TerminalConnection,
  fileName: string,
  content: Buffer,
  sendOutput: SendTerminalOutput,
): Promise<string> {
  console.log("[ssh bridge upload] Start", {
    terminalId: terminal.id,
    fileName,
    bytes: content.length,
  });

  if (isLocalTerminal(terminal)) {
    throw new Error("File drop upload is supported only for SSH terminals.");
  }

  await ensureTerminalConnected(terminal, sendOutput);

  const session = sshSessionStore.get(terminal.id);
  if (!session?.isReady) {
    throw new Error("SSH session is not ready.");
  }

  console.log("[ssh bridge upload] Session ready", {
    terminalId: terminal.id,
    remoteCwd: session.remoteCwd,
  });

  let uploadBaseDir = session.remoteCwd;
  const cwdExists = await PathManager.isRemoteDirectory(
    session.client,
    uploadBaseDir,
  );
  if (!cwdExists) {
    const fallbackDir = session.remoteHomeDir || "/";
    const fallbackExists = await PathManager.isRemoteDirectory(
      session.client,
      fallbackDir,
    );
    if (!fallbackExists) {
      throw new Error(
        `Current directory is invalid and fallback directory does not exist: ${fallbackDir}`,
      );
    }

    console.log("[ssh bridge upload] Tracked cwd invalid, using fallback", {
      terminalId: terminal.id,
      trackedRemoteCwd: session.remoteCwd,
      fallbackDir,
    });
    sendOutput(
      terminal.id,
      `[scp] Current tracked directory does not exist: ${session.remoteCwd}. Using ${fallbackDir}.\r\n`,
    );

    uploadBaseDir = fallbackDir;
    session.remoteCwd = fallbackDir;
  }

  const remotePath = await scpTransfer.uploadRemoteFileToCwd(
    session.client,
    uploadBaseDir,
    fileName,
    content,
  );

  console.log("[ssh bridge upload] Upload complete", {
    terminalId: terminal.id,
    remotePath,
  });

  sendOutput(terminal.id, `[scp] Uploaded ${fileName} → ${remotePath}\r\n`);

  return remotePath;
}
