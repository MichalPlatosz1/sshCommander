import { Client, type ConnectConfig } from "ssh2";
import { existsSync } from "node:fs";
import { posix as posixPath } from "node:path";
import { spawn as ptySpawn, type IPty } from "node-pty";
import {
  completeSshCommanderEditCommand,
  handleSshCommanderEditCommand,
} from "./ssh-commander-edit.js";
import { uploadRemoteFileToCwd } from "./scp-transfer.js";

type SshAuthMethod = "password" | "sshKey";

export type TerminalSshConfig = {
  targetUser: string;
  targetMachine: string;
  targetPort: number;
  authMethod: SshAuthMethod;
  password?: string;
  sshKey?: string;
};

export type TerminalForSsh = {
  id: string;
  name: string;
  ssh: TerminalSshConfig;
};

export type TerminalForLocal = {
  id: string;
  name: string;
  type: "local";
};

export type TerminalConnection = TerminalForSsh | TerminalForLocal;

type SendTerminalOutput = (terminalId: string, text: string) => void;

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

const sessions = new Map<string, TerminalSession>();

type LocalTerminalSession = {
  process: IPty | undefined;
  isReady: boolean;
  connectingPromise: Promise<void> | undefined;
  cols: number;
  rows: number;
};

const localSessions = new Map<string, LocalTerminalSession>();

async function detectRemoteCwd(client: Client): Promise<string | undefined> {
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

async function detectRemoteHomeDir(
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
function normalizeOutputForTerminal(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

async function remoteDirectoryExists(
  client: Client,
  remoteDir: string,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const command = `test -d ${escapeShellArg(remoteDir)} && printf ok || true`;
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

function getStringProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function resolveLocalShellPath(): string {
  const preferredShell = process.env.SHELL;

  if (preferredShell && existsSync(preferredShell)) {
    return preferredShell;
  }

  if (existsSync("/bin/bash")) {
    return "/bin/bash";
  }

  return "/bin/sh";
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function updateRemoteCwdFromCommandLine(
  session: TerminalSession,
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

  const targetDir = stripWrappingQuotes(rawTarget);
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

function trackRemoteCwdFromInteractiveInput(
  session: TerminalSession,
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
      updateRemoteCwdFromCommandLine(session, session.inputLineBuffer);
      session.inputLineBuffer = "";
      continue;
    }

    if (char >= " ") {
      session.inputLineBuffer += char;
    }
  }
}

export async function handleSshCommanderCommand(
  terminal: TerminalConnection,
  commandLine: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await handleSshCommanderEditCommand(terminal, commandLine, sendOutput, {
    ensureTerminalConnected,
    getSession: (terminalId: string) => sessions.get(terminalId),
    isLocalTerminal,
  });
}

function getOrCreateSession(terminalId: string): TerminalSession {
  const existing = sessions.get(terminalId);
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

  sessions.set(terminalId, created);
  return created;
}

function getOrCreateLocalSession(terminalId: string): LocalTerminalSession {
  const existing = localSessions.get(terminalId);
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

  localSessions.set(terminalId, created);
  return created;
}

function isLocalTerminal(
  terminal: TerminalConnection,
): terminal is TerminalForLocal {
  return "type" in terminal && terminal.type === "local";
}

async function ensureLocalTerminalConnected(
  terminal: TerminalForLocal,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  const session = getOrCreateLocalSession(terminal.id);

  if (session.isReady && session.process) {
    return;
  }

  if (session.connectingPromise) {
    return session.connectingPromise;
  }

  session.connectingPromise = new Promise<void>((resolve, reject) => {
    const shell = resolveLocalShellPath();

    try {
      const child = ptySpawn(shell, ["-i"], {
        cwd: process.cwd(),
        env: getStringProcessEnv(),
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
        sendOutput(terminal.id, normalizeOutputForTerminal(chunk));
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

export async function ensureTerminalConnected(
  terminal: TerminalConnection,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  if (isLocalTerminal(terminal)) {
    return ensureLocalTerminalConnected(terminal, sendOutput);
  }

  const session = getOrCreateSession(terminal.id);

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
              normalizeOutputForTerminal(chunk.toString("utf-8")),
            );
          });

          detectRemoteCwd(session.client)
            .then((cwd) => {
              if (cwd) {
                session.remoteCwd = cwd;
              }
            })
            .catch(() => {
              // no-op
            });

          detectRemoteHomeDir(session.client)
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
              normalizeOutputForTerminal(chunk.toString("utf-8")),
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

export async function sendCommandToTerminal(
  terminal: TerminalConnection,
  command: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await sendRawInputToTerminal(terminal, `${command}\n`, sendOutput);
}

export async function sendRawInputToTerminal(
  terminal: TerminalConnection,
  input: string,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  await ensureTerminalConnected(terminal, sendOutput);

  if (isLocalTerminal(terminal)) {
    const session = localSessions.get(terminal.id);
    if (!session?.process || !session.isReady) {
      sendOutput(terminal.id, "[local error] Terminal stream is not ready.");
      return;
    }

    // Keep CR/LF bytes from xterm as-is.
    // Converting Enter (\r) to \n causes cursor/prompt misalignment in zsh/bash.
    session.process.write(input);
    return;
  }

  const session = sessions.get(terminal.id);
  if (!session?.stream || !session.isReady) {
    sendOutput(terminal.id, "[ssh error] Terminal stream is not ready.");
    return;
  }

  // Track CWD changes for relative path resolution.
  trackRemoteCwdFromInteractiveInput(session, input);
  session.stream.write(input);
}

export async function resizeTerminalPty(
  terminal: TerminalConnection,
  cols: number,
  rows: number,
  sendOutput: SendTerminalOutput,
): Promise<void> {
  if (isLocalTerminal(terminal)) {
    const session = getOrCreateLocalSession(terminal.id);

    session.cols = cols;
    session.rows = rows;

    if (session.process && session.isReady) {
      session.process.resize(cols, rows);
    }

    return;
  }

  const session = getOrCreateSession(terminal.id);

  session.cols = cols;
  session.rows = rows;

  if (!session.stream || !session.isReady) {
    return;
  }

  if (typeof session.stream.setWindow === "function") {
    session.stream.setWindow(rows, cols, 0, 0);
  }
}

export function resetTerminalConnection(terminalId: string) {
  const localSession = localSessions.get(terminalId);
  if (localSession) {
    localSession.process?.kill();
    localSessions.delete(terminalId);
  }

  const session = sessions.get(terminalId);
  if (!session) {
    return;
  }

  session.stream = undefined;
  session.isReady = false;
  session.connectingPromise = undefined;
  session.client.removeAllListeners();
  session.client.end();
  sessions.delete(terminalId);
}

export async function completeSshCommanderCommand(
  terminal: TerminalConnection,
  commandLine: string,
): Promise<string | undefined> {
  return await completeSshCommanderEditCommand(terminal, commandLine, {
    ensureTerminalConnected,
    getSession: (terminalId: string) => sessions.get(terminalId),
    isLocalTerminal,
  });
}

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

  const session = sessions.get(terminal.id);
  if (!session?.isReady) {
    throw new Error("SSH session is not ready.");
  }

  console.log("[ssh bridge upload] Session ready", {
    terminalId: terminal.id,
    remoteCwd: session.remoteCwd,
  });

  let uploadBaseDir = session.remoteCwd;
  const cwdExists = await remoteDirectoryExists(session.client, uploadBaseDir);
  if (!cwdExists) {
    const fallbackDir = session.remoteHomeDir || "/";
    const fallbackExists = await remoteDirectoryExists(
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

  const remotePath = await uploadRemoteFileToCwd(
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
