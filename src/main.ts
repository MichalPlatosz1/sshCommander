import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "socket.io";
import {
  completeSshCommanderCommand,
  ensureTerminalConnected,
  handleSshCommanderCommand,
  resetTerminalConnection,
  sendCommandToTerminal,
  sendRawInputToTerminal,
  resizeTerminalPty,
  uploadFileToTerminalCurrentDirectory,
  type TerminalForLocal,
  type TerminalConnection,
} from "./ssh-terminal-bridge.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

type CreateTerminalRequest = {
  name: string;
  ssh: {
    targetUser: string;
    targetMachine: string;
    targetPort: number;
    authMethod: "password" | "sshKey";
    password?: string;
    sshKey?: string;
  };
};

type Terminal = {
  id: string;
  name: string;
  ssh: CreateTerminalRequest["ssh"];
};

const localTerminal: TerminalForLocal = {
  id: "local-machine",
  name: "Current machine",
  type: "local",
};

type TerminalCommandPayload = {
  terminalId: string;
  command: string;
};

type TerminalInputPayload = {
  terminalId: string;
  input: string;
};

type TerminalResizePayload = {
  terminalId: string;
  cols: number;
  rows: number;
};

type SshCommanderPayload = {
  terminalId: string;
  commandLine: string;
};

type SshCommanderCompletionResponse = {
  completedLine?: string;
};

type TerminalOutputPayload = {
  terminalId: string;
  text: string;
};

const terminalsStoragePath = path.resolve(
  process.cwd(),
  "data",
  "terminals.json",
);

function loadStoredTerminals(): Terminal[] {
  if (!existsSync(terminalsStoragePath)) {
    return [];
  }

  try {
    const fileContent = readFileSync(terminalsStoragePath, "utf-8");
    const parsed = JSON.parse(fileContent) as Terminal[];

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((terminal) => ({
      ...terminal,
      ssh: {
        ...terminal.ssh,
        targetPort:
          typeof terminal.ssh?.targetPort === "number" &&
          Number.isInteger(terminal.ssh.targetPort)
            ? terminal.ssh.targetPort
            : 22,
      },
    }));
  } catch {
    return [];
  }
}

function saveStoredTerminals(terminals: Terminal[]) {
  mkdirSync(path.dirname(terminalsStoragePath), { recursive: true });
  writeFileSync(
    terminalsStoragePath,
    JSON.stringify(terminals, null, 2),
    "utf-8",
  );
}

const terminals: Terminal[] = loadStoredTerminals();

function getTerminalById(terminalId: string): TerminalConnection | undefined {
  if (terminalId === localTerminal.id) {
    return localTerminal;
  }

  return terminals.find((item) => item.id === terminalId);
}

function sendTextToTerminal(terminalId: Terminal["id"], text: string) {
  const payload: TerminalOutputPayload = { terminalId, text };
  io.to(`terminal:${terminalId}`).emit("terminal_output", payload);
}

function buildTerminalFromRequest(
  body: CreateTerminalRequest,
  id: string,
): { terminal?: Terminal; error?: string } {
  const name = body?.name?.trim();
  const targetUser = body?.ssh?.targetUser?.trim();
  const targetMachine = body?.ssh?.targetMachine?.trim();
  const targetPort = Number(body?.ssh?.targetPort);
  const authMethod = body?.ssh?.authMethod;
  const password = body?.ssh?.password?.trim();
  const sshKey = body?.ssh?.sshKey?.trim();

  if (!name) {
    return { error: "Terminal name is required." };
  }

  if (!targetUser || !targetMachine) {
    return { error: "SSH target user and target machine are required." };
  }

  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return { error: "SSH target port must be an integer between 1 and 65535." };
  }

  if (authMethod !== "password" && authMethod !== "sshKey") {
    return { error: "SSH auth method must be password or sshKey." };
  }

  if (authMethod === "password" && !password) {
    return { error: "SSH password is required." };
  }

  if (authMethod === "sshKey" && !sshKey) {
    return { error: "SSH key is required." };
  }

  const sshConfig: Terminal["ssh"] =
    authMethod === "password"
      ? {
          targetUser,
          targetMachine,
          targetPort,
          authMethod,
          password: password!,
        }
      : {
          targetUser,
          targetMachine,
          targetPort,
          authMethod,
          sshKey: sshKey!,
        };

  return {
    terminal: {
      id,
      name,
      ssh: sshConfig,
    },
  };
}

app.get("/api/terminals", (_req, res) => {
  return res.json([localTerminal, ...terminals]);
});

app.post("/api/terminals", (req, res) => {
  const result = buildTerminalFromRequest(
    req.body as CreateTerminalRequest,
    randomUUID(),
  );
  if (!result.terminal) {
    return res.status(400).json({ message: result.error });
  }

  terminals.push(result.terminal);
  saveStoredTerminals(terminals);

  return res.status(201).json(result.terminal);
});

app.put("/api/terminals/:terminalId", (req, res) => {
  const terminalId = req.params.terminalId;
  const index = terminals.findIndex((item) => item.id === terminalId);

  if (index === -1) {
    return res.status(404).json({ message: "Terminal not found." });
  }

  const result = buildTerminalFromRequest(
    req.body as CreateTerminalRequest,
    terminalId,
  );
  if (!result.terminal) {
    return res.status(400).json({ message: result.error });
  }

  terminals[index] = result.terminal;
  saveStoredTerminals(terminals);
  resetTerminalConnection(terminalId);

  return res.json(result.terminal);
});

app.post(
  "/api/terminals/:terminalId/upload",
  upload.single("file"),
  async (req, res) => {
    const terminalId = req.params.terminalId;
    console.log("[upload] Request received", {
      terminalId,
      hasFile: Boolean(req.file),
    });
    if (!terminalId) {
      return res.status(400).json({ message: "Missing terminal id." });
    }

    const terminal = getTerminalById(terminalId);

    if (!terminal) {
      return res.status(404).json({ message: "Terminal not found." });
    }

    if ("type" in terminal && terminal.type === "local") {
      return res
        .status(400)
        .json({ message: "Local terminals do not support SCP upload." });
    }

    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({ message: "Missing file payload." });
    }

    console.log("[upload] File payload", {
      terminalId,
      name: uploadedFile.originalname,
      size: uploadedFile.size,
      mimeType: uploadedFile.mimetype,
    });

    if (uploadedFile.size <= 0) {
      return res.status(400).json({ message: "Uploaded file is empty." });
    }

    try {
      console.log("[upload] Uploading to remote terminal cwd", {
        terminalId,
        fileName: uploadedFile.originalname,
      });
      const remotePath = await uploadFileToTerminalCurrentDirectory(
        terminal,
        uploadedFile.originalname,
        uploadedFile.buffer,
        sendTextToTerminal,
      );

      console.log("[upload] Upload success", {
        terminalId,
        remotePath,
      });

      return res.status(201).json({
        terminalId,
        fileName: uploadedFile.originalname,
        size: uploadedFile.size,
        remotePath,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown upload error";
      console.log("[upload] Upload failed", {
        terminalId,
        message,
      });
      sendTextToTerminal(terminalId, `[scp error] ${message}\r\n`);
      return res.status(500).json({ message });
    }
  },
);

io.on("connection", (socket) => {
  socket.on(
    "join_terminal",
    async ({ terminalId }: { terminalId: Terminal["id"] }) => {
      if (!terminalId) {
        return;
      }

      socket.join(`terminal:${terminalId}`);

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        sendTextToTerminal(
          terminalId,
          `[error] Terminal ${terminalId} was not found.`,
        );
        return;
      }

      try {
        await ensureTerminalConnected(terminal, sendTextToTerminal);
      } catch {
        // Error message is already emitted by SSH bridge.
      }
    },
  );

  socket.on(
    "terminal_command",
    async ({ terminalId, command }: TerminalCommandPayload) => {
      const roomName = `terminal:${terminalId}`;

      if (!terminalId || !command || !socket.rooms.has(roomName)) {
        return;
      }

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        sendTextToTerminal(
          terminalId,
          `[error] Terminal ${terminalId} was not found.`,
        );
        return;
      }

      try {
        await sendCommandToTerminal(terminal, command, sendTextToTerminal);
      } catch {
        // Error message is already emitted by SSH bridge.
      }
    },
  );

  socket.on(
    "terminal_input",
    async ({ terminalId, input }: TerminalInputPayload) => {
      const roomName = `terminal:${terminalId}`;

      if (!terminalId || !input || !socket.rooms.has(roomName)) {
        return;
      }

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        sendTextToTerminal(
          terminalId,
          `[error] Terminal ${terminalId} was not found.`,
        );
        return;
      }

      try {
        await sendRawInputToTerminal(terminal, input, sendTextToTerminal);
      } catch {
        // Error message is already emitted by SSH bridge.
      }
    },
  );

  socket.on(
    "terminal_resize",
    async ({ terminalId, cols, rows }: TerminalResizePayload) => {
      const roomName = `terminal:${terminalId}`;

      if (
        !terminalId ||
        !socket.rooms.has(roomName) ||
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols <= 0 ||
        rows <= 0
      ) {
        return;
      }

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        return;
      }

      try {
        await resizeTerminalPty(terminal, cols, rows, sendTextToTerminal);
      } catch {
        // Error message is already emitted by SSH bridge.
      }
    },
  );

  socket.on(
    "ssh_commander_command",
    async ({ terminalId, commandLine }: SshCommanderPayload) => {
      console.log(
        "[Backend] Received ssh_commander_command:",
        terminalId,
        commandLine,
      );
      const roomName = `terminal:${terminalId}`;

      if (!terminalId || !commandLine || !socket.rooms.has(roomName)) {
        console.log(
          "[Backend] Validation failed: terminalId=",
          terminalId,
          "commandLine=",
          commandLine,
          "inRoom=",
          socket.rooms.has(roomName),
        );
        return;
      }

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        sendTextToTerminal(
          terminalId,
          `[error] Terminal ${terminalId} was not found.`,
        );
        return;
      }

      try {
        await handleSshCommanderCommand(
          terminal,
          commandLine,
          sendTextToTerminal,
        );
      } catch {
        // Error message is already emitted by SSH bridge.
      }
    },
  );

  socket.on(
    "ssh_commander_complete",
    async (
      { terminalId, commandLine }: SshCommanderPayload,
      callback?: (response: SshCommanderCompletionResponse) => void,
    ) => {
      const roomName = `terminal:${terminalId}`;

      if (!terminalId || !commandLine || !socket.rooms.has(roomName)) {
        callback?.({});
        return;
      }

      const terminal = getTerminalById(terminalId);
      if (!terminal) {
        callback?.({});
        return;
      }

      try {
        const completedLine = await completeSshCommanderCommand(
          terminal,
          commandLine,
        );
        if (completedLine) {
          callback?.({ completedLine });
        } else {
          callback?.({});
        }
      } catch {
        callback?.({});
      }
    },
  );
});

httpServer.listen(PORT, () => {
  console.log(`Backend is running on http://localhost:${PORT}`);
});

/*

// Stuff used for serving the React app in production. During development, Vite's dev server handles this with the proxy setup in vite.config.ts.

const clientDistPath = path.resolve(process.cwd(), "client", "dist");
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}
*/
