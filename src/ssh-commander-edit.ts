import {
  SshCommanderEditHandler,
  type SendTerminalOutput,
  type SshCommanderEditDependencies,
} from "./services/ssh-commander-edit-service.js";
import type { TerminalConnection } from "./types/terminal.js";

const sshCommanderEditHandler = new SshCommanderEditHandler();

/**
 * Adapter entry-point for `sshCommander edit` command completion.
 *
 * Delegates completion logic to `SshCommanderEditHandler`.
 */
export async function completeSshCommanderEditCommand(
  terminal: TerminalConnection,
  commandLine: string,
  deps: SshCommanderEditDependencies,
): Promise<string | undefined> {
  return await sshCommanderEditHandler.completeEditCommand(
    terminal,
    commandLine,
    deps,
  );
}

/**
 * Adapter entry-point for handling `sshCommander` command execution.
 *
 * Delegates runtime command handling to `SshCommanderEditHandler`.
 */
export async function handleSshCommanderEditCommand(
  terminal: TerminalConnection,
  commandLine: string,
  sendOutput: SendTerminalOutput,
  deps: SshCommanderEditDependencies,
): Promise<void> {
  await sshCommanderEditHandler.handleEditCommand(
    terminal,
    commandLine,
    sendOutput,
    deps,
  );
}
