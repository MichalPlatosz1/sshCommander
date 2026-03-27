import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  CreateTerminalRequest,
  TerminalConnection,
  TerminalForLocal,
  TerminalForSsh,
} from "../types/terminal.js";

type TerminalBuildResult = { terminal?: TerminalForSsh; error?: string };

/**
 * Persistent storage and validation for terminal configurations.
 */
export class TerminalRepository {
  private readonly terminals: TerminalForSsh[];

  constructor(
    private readonly storagePath: string,
    private readonly localTerminal: TerminalForLocal,
  ) {
    this.terminals = this.loadStoredTerminals();
  }

  listAll(): TerminalConnection[] {
    return [this.localTerminal, ...this.terminals];
  }

  getById(terminalId: string): TerminalConnection | undefined {
    if (terminalId === this.localTerminal.id) {
      return this.localTerminal;
    }

    return this.terminals.find((terminal) => terminal.id === terminalId);
  }

  create(request: CreateTerminalRequest): TerminalBuildResult {
    const built = this.buildTerminalFromRequest(request, randomUUID());
    if (!built.terminal) {
      return built;
    }

    this.terminals.push(built.terminal);
    this.saveStoredTerminals();
    return built;
  }

  update(
    terminalId: string,
    request: CreateTerminalRequest,
  ): TerminalBuildResult {
    const index = this.terminals.findIndex(
      (terminal) => terminal.id === terminalId,
    );
    if (index === -1) {
      return { error: "Terminal not found." };
    }

    const built = this.buildTerminalFromRequest(request, terminalId);
    if (!built.terminal) {
      return built;
    }

    this.terminals[index] = built.terminal;
    this.saveStoredTerminals();
    return built;
  }

  private loadStoredTerminals(): TerminalForSsh[] {
    if (!existsSync(this.storagePath)) {
      return [];
    }

    try {
      const fileContent = readFileSync(this.storagePath, "utf-8");
      const parsed = JSON.parse(fileContent) as TerminalForSsh[];
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

  private saveStoredTerminals() {
    mkdirSync(path.dirname(this.storagePath), { recursive: true });
    writeFileSync(
      this.storagePath,
      JSON.stringify(this.terminals, null, 2),
      "utf-8",
    );
  }

  private buildTerminalFromRequest(
    body: CreateTerminalRequest,
    terminalId: string,
  ): TerminalBuildResult {
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
      return {
        error: "SSH target port must be an integer between 1 and 65535.",
      };
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

    return {
      terminal: {
        id: terminalId,
        name,
        ssh:
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
              },
      },
    };
  }
}

export const defaultLocalTerminal: TerminalForLocal = {
  id: "local-machine",
  name: "Current machine",
  type: "local",
};
