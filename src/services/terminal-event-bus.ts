import { Server } from "socket.io";

export type TerminalOutputPayload = {
  terminalId: string;
  text: string;
};

/**
 * Emits terminal output messages to interested Socket.IO rooms.
 */
export class TerminalEventBus {
  constructor(private readonly io: Server) {}

  sendOutput(terminalId: string, text: string) {
    const payload: TerminalOutputPayload = { terminalId, text };
    this.io.to(this.getRoomName(terminalId)).emit("terminal_output", payload);
  }

  getRoomName(terminalId: string): string {
    return `terminal:${terminalId}`;
  }
}
