import TerminalModal from "./TerminalModal";
import CreateTerminalView from "./CreateTerminalView";

type SshAuthMethod = "password" | "sshKey";

type SshConnectionConfig = {
  targetUser: string;
  targetMachine: string;
  targetPort: number;
  authMethod: SshAuthMethod;
  password?: string;
  sshKey?: string;
};

type SshTerminal = {
  id: string;
  name: string;
  type?: "ssh";
  ssh: SshConnectionConfig;
};

type LocalTerminal = {
  id: string;
  name: string;
  type: "local";
};

type TerminalModel = SshTerminal | LocalTerminal;

type CreateTerminalRequest = {
  name: string;
  ssh: SshConnectionConfig;
};

type TerminalUploadStatus = {
  phase: "uploading" | "finishing" | "done";
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
};

type WorkspacePanelProps = {
  isCreateTerminalViewOpen: boolean;
  editingTerminalId: string | null;
  createTerminalConfig: CreateTerminalRequest;
  terminals: TerminalModel[];
  openTerminalIds: string[];
  terminalOutput: Record<string, string[]>;
  terminalUploadStatuses: Record<string, TerminalUploadStatus | undefined>;
  terminalWindowPositions: Record<string, { x: number; y: number }>;
  terminalWindowSizes: Record<string, { width: number; height: number }>;
  terminalZOrder: string[];
  onCreateTerminalConfigChange: (value: CreateTerminalRequest) => void;
  onSaveTerminalConfig: () => void;
  onCancelCreateOrEdit: () => void;
  onSendRawInput: (terminalId: string, input: string) => void;
  onSshCommanderCommand: (terminalId: string, commandLine: string) => void;
  onSshCommanderComplete: (terminalId: string, commandLine: string) => Promise<string | undefined>;
  onDropFilesToTerminal: (terminalId: string, files: File[]) => Promise<void>;
  onTerminalResize: (terminalId: string, cols: number, rows: number) => void;
  onTerminalPositionChange: (terminalId: string, position: { x: number; y: number }) => void;
  onTerminalSizeChange: (terminalId: string, size: { width: number; height: number }) => void;
  onTerminalFocus: (terminalId: string) => void;
  onTerminalClose: (terminalId: string) => void;
};

function WorkspacePanel({
  isCreateTerminalViewOpen,
  editingTerminalId,
  createTerminalConfig,
  terminals,
  openTerminalIds,
  terminalOutput,
  terminalUploadStatuses,
  terminalWindowPositions,
  terminalWindowSizes,
  terminalZOrder,
  onCreateTerminalConfigChange,
  onSaveTerminalConfig,
  onCancelCreateOrEdit,
  onSendRawInput,
  onSshCommanderCommand,
  onSshCommanderComplete,
  onDropFilesToTerminal,
  onTerminalResize,
  onTerminalPositionChange,
  onTerminalSizeChange,
  onTerminalFocus,
  onTerminalClose,
}: WorkspacePanelProps) {
  return (
    <section className="relative overflow-hidden rounded-box border border-base-300 bg-base-100 p-6 shadow-lg">
      <p className="pointer-events-none absolute right-4 top-4 z-20 max-w-sm text-right text-xs text-base-content/50">
        Tip: Special app commands are available in terminal under
        <span className="font-semibold"> sshCommander</span>
        (for example: <span className="font-semibold">sshCommander --help</span>).
      </p>

      {isCreateTerminalViewOpen ? (
        <CreateTerminalView
          config={createTerminalConfig}
          onConfigChange={onCreateTerminalConfigChange}
          onCreateTerminal={onSaveTerminalConfig}
          title={editingTerminalId ? "Edit terminal" : "Create terminal"}
          submitLabel={editingTerminalId ? "Save changes" : "Create terminal"}
          onCancel={onCancelCreateOrEdit}
        />
      ) : openTerminalIds.length > 0 ? (
        openTerminalIds
          .map((openId) => terminals.find((terminal) => terminal.id === openId))
          .filter((terminal): terminal is TerminalModel => Boolean(terminal))
          .map((terminal) => (
            <TerminalModal
              key={terminal.id}
              terminal={terminal}
              outputLines={terminalOutput[terminal.id] ?? []}
              uploadStatus={terminalUploadStatuses[terminal.id]}
              onSendRawInput={(input) => onSendRawInput(terminal.id, input)}
              onSshCommanderCommand={(commandLine) =>
                onSshCommanderCommand(terminal.id, commandLine)
              }
              onSshCommanderComplete={(commandLine) =>
                onSshCommanderComplete(terminal.id, commandLine)
              }
              onDropFiles={(files) => onDropFilesToTerminal(terminal.id, files)}
              onResize={(cols, rows) => onTerminalResize(terminal.id, cols, rows)}
              position={terminalWindowPositions[terminal.id] ?? { x: 24, y: 24 }}
              onPositionChange={(position) => onTerminalPositionChange(terminal.id, position)}
              size={terminalWindowSizes[terminal.id] ?? { width: 900, height: 420 }}
              onSizeChange={(size) => onTerminalSizeChange(terminal.id, size)}
              zIndex={100 + terminalZOrder.indexOf(terminal.id)}
              onFocus={() => onTerminalFocus(terminal.id)}
              onClose={() => onTerminalClose(terminal.id)}
            />
          ))
      ) : (
        <>
          <h2 className="text-xl font-semibold">Workspace</h2>
          <p className="mt-2 text-base-content/70">
            Select a terminal on the left to open its terminal window.
          </p>
        </>
      )}
    </section>
  );
}

export default WorkspacePanel;
