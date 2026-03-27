export type SshAuthMethod = "password" | "sshKey";

export type TerminalSshConfig = {
  targetUser: string;
  targetMachine: string;
  targetPort: number;
  authMethod: SshAuthMethod;
  password?: string;
  sshKey?: string;
};

export type CreateTerminalRequest = {
  name: string;
  ssh: TerminalSshConfig;
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

export type TerminalCommandPayload = {
  terminalId: string;
  command: string;
};

export type TerminalInputPayload = {
  terminalId: string;
  input: string;
};

export type TerminalResizePayload = {
  terminalId: string;
  cols: number;
  rows: number;
};

export type SshCommanderPayload = {
  terminalId: string;
  commandLine: string;
};

export type SshCommanderCompletionResponse = {
  completedLine?: string;
};
