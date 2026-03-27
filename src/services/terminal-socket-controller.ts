import { Server } from "socket.io";
import {
  completeSshCommanderCommand,
  ensureTerminalConnected,
  handleSshCommanderCommand,
  resizeTerminalPty,
  sendCommandToTerminal,
  sendRawInputToTerminal,
} from "../ssh-terminal-bridge.js";
import { TerminalEventBus } from "./terminal-event-bus.js";
import { TerminalRepository } from "./terminal-repository.js";
import type {
  SshCommanderCompletionResponse,
  SshCommanderPayload,
  TerminalCommandPayload,
  TerminalInputPayload,
  TerminalResizePayload,
} from "../types/terminal.js";

/**
 * Binds Socket.IO events for terminal lifecycle and I/O.
 */
export class TerminalSocketController {
  constructor(
    private readonly io: Server,
    private readonly repository: TerminalRepository,
    private readonly eventBus: TerminalEventBus,
  ) {}

  registerHandlers() {
    this.io.on("connection", (socket) => {
      socket.on(
        "join_terminal",
        async ({ terminalId }: { terminalId: string }) => {
          if (!terminalId) {
            return;
          }

          socket.join(this.eventBus.getRoomName(terminalId));
          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            this.eventBus.sendOutput(
              terminalId,
              `[error] Terminal ${terminalId} was not found.`,
            );
            return;
          }

          try {
            await ensureTerminalConnected(
              terminal,
              this.eventBus.sendOutput.bind(this.eventBus),
            );
          } catch {
            // Error message is already emitted by SSH bridge.
          }
        },
      );

      socket.on(
        "terminal_command",
        async ({ terminalId, command }: TerminalCommandPayload) => {
          const roomName = this.eventBus.getRoomName(terminalId);
          if (!terminalId || !command || !socket.rooms.has(roomName)) {
            return;
          }

          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            this.eventBus.sendOutput(
              terminalId,
              `[error] Terminal ${terminalId} was not found.`,
            );
            return;
          }

          try {
            await sendCommandToTerminal(
              terminal,
              command,
              this.eventBus.sendOutput.bind(this.eventBus),
            );
          } catch {
            // Error message is already emitted by SSH bridge.
          }
        },
      );

      socket.on(
        "terminal_input",
        async ({ terminalId, input }: TerminalInputPayload) => {
          const roomName = this.eventBus.getRoomName(terminalId);
          if (!terminalId || !input || !socket.rooms.has(roomName)) {
            return;
          }

          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            this.eventBus.sendOutput(
              terminalId,
              `[error] Terminal ${terminalId} was not found.`,
            );
            return;
          }

          try {
            await sendRawInputToTerminal(
              terminal,
              input,
              this.eventBus.sendOutput.bind(this.eventBus),
            );
          } catch {
            // Error message is already emitted by SSH bridge.
          }
        },
      );

      socket.on(
        "terminal_resize",
        async ({ terminalId, cols, rows }: TerminalResizePayload) => {
          const roomName = this.eventBus.getRoomName(terminalId);
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

          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            return;
          }

          try {
            await resizeTerminalPty(
              terminal,
              cols,
              rows,
              this.eventBus.sendOutput.bind(this.eventBus),
            );
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

          const roomName = this.eventBus.getRoomName(terminalId);
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

          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            this.eventBus.sendOutput(
              terminalId,
              `[error] Terminal ${terminalId} was not found.`,
            );
            return;
          }

          try {
            await handleSshCommanderCommand(
              terminal,
              commandLine,
              this.eventBus.sendOutput.bind(this.eventBus),
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
          const roomName = this.eventBus.getRoomName(terminalId);
          if (!terminalId || !commandLine || !socket.rooms.has(roomName)) {
            callback?.({});
            return;
          }

          const terminal = this.repository.getById(terminalId);
          if (!terminal) {
            callback?.({});
            return;
          }

          try {
            const completedLine = await completeSshCommanderCommand(
              terminal,
              commandLine,
            );
            callback?.(completedLine ? { completedLine } : {});
          } catch {
            callback?.({});
          }
        },
      );
    });
  }
}
