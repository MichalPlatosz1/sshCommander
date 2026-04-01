import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import WorkspacePanel from "./components/WorkspacePanel";

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

type TerminalOutputPayload = {
  terminalId: string;
  text: string;
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

function getDefaultCreateTerminalConfig(): CreateTerminalRequest {
  return {
    name: "",
    ssh: {
      targetUser: "",
      targetMachine: "",
      targetPort: 22,
      authMethod: "password",
      password: "",
    },
  };
}

async function createTerminal(payload: CreateTerminalRequest) {
  const response = await fetch("/api/terminals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const data: SshTerminal = await response.json();
  return data;
}

async function updateTerminal(terminalId: string, payload: CreateTerminalRequest) {
  const response = await fetch(`/api/terminals/${terminalId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const data: SshTerminal = await response.json();
  return data;
}

async function getTerminals() {
  const response = await fetch("/api/terminals");

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const data: TerminalModel[] = await response.json();
  return data.map((terminal) => {
    if ("type" in terminal && terminal.type === "local" && !terminal.id) {
      return {
        ...terminal,
        id: "local-machine",
      };
    }

    return terminal;
  });
}

async function uploadTerminalFile(
  terminalId: string,
  file: File,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
) {
  const formData = new FormData();
  formData.append("file", file);

  return await new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/terminals/${terminalId}/upload`);

    xhr.upload.onprogress = (event) => {
      const totalBytes = event.lengthComputable ? event.total : file.size;
      onProgress?.(event.loaded, totalBytes);
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed due to network error."));
    };

    xhr.onload = () => {
      let payload: { message?: string } | undefined;
      try {
        payload = xhr.responseText ? (JSON.parse(xhr.responseText) as { message?: string }) : {};
      } catch {
        payload = {};
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload?.message ?? `Upload failed: ${xhr.status}`));
        return;
      }

      resolve(payload);
    };

    xhr.send(formData);
  });
}

function App() {
  // Global error display
  const [error, setError] = useState<string | null>(null);

  // List of terminals
  const [terminals, setTerminals] = useState<TerminalModel[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [openTerminalIds, setOpenTerminalIds] = useState<string[]>([]);
  const [terminalZOrder, setTerminalZOrder] = useState<string[]>([]);
  const [terminalOutput, setTerminalOutput] = useState<Record<string, string[]>>({});
  const [terminalWindowPositions, setTerminalWindowPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const [terminalWindowSizes, setTerminalWindowSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const [terminalUploadStatuses, setTerminalUploadStatuses] = useState<
    Record<string, TerminalUploadStatus | undefined>
  >({});
  const socketRef = useRef<Socket | null>(null);

  // State for create terminal form
  const [isCreateTerminalViewOpen, setIsCreateTerminalViewOpen] = useState(false);
  const [editingTerminalId, setEditingTerminalId] = useState<string | null>(null);
  const [createTerminalConfig, setCreateTerminalConfig] = useState<CreateTerminalRequest>(
    getDefaultCreateTerminalConfig(),
  );

  const bringTerminalToFront = (terminalId: string) => {
    setTerminalZOrder((prev) => [...prev.filter((id) => id !== terminalId), terminalId]);
  };

  const openTerminalWindow = (terminalId: string) => {
    setOpenTerminalIds((prev) => {
      if (prev.includes(terminalId)) {
        return prev;
      }

      const nextIndex = prev.length;
      setTerminalWindowPositions((positions) => ({
        ...positions,
        [terminalId]: positions[terminalId] ?? {
          x: 24 + nextIndex * 28,
          y: 24 + nextIndex * 22,
        },
      }));
      setTerminalWindowSizes((sizes) => ({
        ...sizes,
        [terminalId]: sizes[terminalId] ?? {
          width: 900,
          height: 420,
        },
      }));

      return [...prev, terminalId];
    });

    bringTerminalToFront(terminalId);
    setSelectedTerminalId(terminalId);
    setIsCreateTerminalViewOpen(false);
    setEditingTerminalId(null);
  };

  const closeTerminalWindow = (terminalId: string) => {
    setOpenTerminalIds((prev) => prev.filter((id) => id !== terminalId));
    setTerminalZOrder((prev) => prev.filter((id) => id !== terminalId));
  };

  const buildTerminalPayloadFromConfig = (): CreateTerminalRequest | null => {
    const trimmedName = createTerminalConfig.name.trim();
    const trimmedTargetUser = createTerminalConfig.ssh.targetUser.trim();
    const trimmedTargetMachine = createTerminalConfig.ssh.targetMachine.trim();
    const targetPort = createTerminalConfig.ssh.targetPort;
    const trimmedPassword = createTerminalConfig.ssh.password?.trim();
    const trimmedSshKey = createTerminalConfig.ssh.sshKey?.trim();

    if (!trimmedName || !trimmedTargetUser || !trimmedTargetMachine) {
      setError("Terminal name, target user and target machine are required.");
      return null;
    }

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      setError("Target port must be an integer between 1 and 65535.");
      return null;
    }

    if (createTerminalConfig.ssh.authMethod === "password" && !trimmedPassword) {
      setError("Password is required when password authentication is selected.");
      return null;
    }

    if (createTerminalConfig.ssh.authMethod === "sshKey" && !trimmedSshKey) {
      setError("SSH key is required when SSH key authentication is selected.");
      return null;
    }

    return {
      name: trimmedName,
      ssh: {
        targetUser: trimmedTargetUser,
        targetMachine: trimmedTargetMachine,
        targetPort,
        authMethod: createTerminalConfig.ssh.authMethod,
        ...(createTerminalConfig.ssh.authMethod === "password"
          ? { password: trimmedPassword }
          : { sshKey: trimmedSshKey }),
      },
    };
  };

  const handleSaveTerminalConfig = async () => {
    const payload = buildTerminalPayloadFromConfig();
    if (!payload) {
      return;
    }

    try {
      if (editingTerminalId) {
        const updatedTerminal = await updateTerminal(editingTerminalId, payload);
        setTerminals((prev) =>
          prev.map((terminal) =>
            terminal.id === updatedTerminal.id ? updatedTerminal : terminal,
          ),
        );
        openTerminalWindow(updatedTerminal.id);
      } else {
        const createdTerminal = await createTerminal(payload);
        setTerminals((prev) => [createdTerminal, ...prev]);
        openTerminalWindow(createdTerminal.id);
      }

      setCreateTerminalConfig(getDefaultCreateTerminalConfig());
      setIsCreateTerminalViewOpen(false);
      setEditingTerminalId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("Error creating terminal:", err);
      setError(message);
    }
  };

  const handleOpenCreateTerminalView = () => {
    setEditingTerminalId(null);
    setCreateTerminalConfig(getDefaultCreateTerminalConfig());
    setIsCreateTerminalViewOpen(true);
  };

  const handleOpenEditTerminalView = (terminalToEdit?: SshTerminal) => {
    const targetTerminal = terminalToEdit ?? selectedTerminal;
    if (!targetTerminal) {
      setError("Select a terminal first to edit its config.");
      return;
    }

    if (!("ssh" in targetTerminal)) {
      setError("Local machine terminal config cannot be edited.");
      return;
    }

    setEditingTerminalId(targetTerminal.id);
    setCreateTerminalConfig({
      name: targetTerminal.name,
      ssh: {
        targetUser: targetTerminal.ssh.targetUser,
        targetMachine: targetTerminal.ssh.targetMachine,
        targetPort: targetTerminal.ssh.targetPort,
        authMethod: targetTerminal.ssh.authMethod,
        ...(targetTerminal.ssh.authMethod === "password"
          ? { password: targetTerminal.ssh.password ?? "" }
          : { sshKey: targetTerminal.ssh.sshKey ?? "" }),
      },
    });
    setSelectedTerminalId(targetTerminal.id);
    setIsCreateTerminalViewOpen(true);
  };

  useEffect(() => {
    getTerminals()
      .then((storedTerminals) => {
        setTerminals(storedTerminals);
        if (storedTerminals.length > 0) {
          setSelectedTerminalId(storedTerminals[0].id);
          openTerminalWindow(storedTerminals[0].id);
        }
      })
      .catch((err: Error) => {
        setError(`Failed to load saved terminals: ${err.message}`);
      });
  }, []);

  useEffect(() => {
    const socket = io({
      path: "/socket.io",
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });

    socketRef.current = socket;

    socket.on("connect_error", (err: Error) => {
      setError(`Socket connection failed: ${err.message}`);
    });

    socket.on("terminal_output", ({ terminalId, text }: TerminalOutputPayload) => {
      setTerminalOutput((prev) => ({
        ...prev,
        [terminalId]: [...(prev[terminalId] ?? []), text],
      }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!socketRef.current || openTerminalIds.length === 0) {
      return;
    }

    openTerminalIds.forEach((terminalId) => {
      socketRef.current?.emit("join_terminal", { terminalId });
    });
  }, [openTerminalIds]);

  const selectedTerminal = terminals.find((terminal) => terminal.id === selectedTerminalId);

  const handleSendRawInput = (terminalId: string, input: string) => {
    if (!input || !socketRef.current) {
      return;
    }

    socketRef.current.emit("terminal_input", {
      terminalId,
      input,
    });
  };

  const handleTerminalResize = (terminalId: string, cols: number, rows: number) => {
    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit("terminal_resize", {
      terminalId,
      cols,
      rows,
    });
  };

  const handleSshCommanderCommand = (terminalId: string, commandLine: string) => {
    if (!commandLine || !socketRef.current) {
      return;
    }

    socketRef.current.emit("ssh_commander_command", {
      terminalId,
      commandLine,
    });
  };

  const handleSshCommanderComplete = async (
    terminalId: string,
    commandLine: string,
  ): Promise<string | undefined> => {
    if (!commandLine || !socketRef.current) {
      return undefined;
    }

    return await new Promise<string | undefined>((resolve) => {
      socketRef.current?.emit(
        "ssh_commander_complete",
        { terminalId, commandLine },
        (response: { completedLine?: string }) => {
          resolve(response?.completedLine);
        },
      );
    });
  };

  const handleDropFilesToTerminal = async (terminalId: string, files: File[]) => {
    if (files.length === 0) {
      return;
    }

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;

        setTerminalUploadStatuses((prev) => ({
          ...prev,
          [terminalId]: {
            phase: "uploading",
            fileName: file.name,
            fileIndex: index + 1,
            totalFiles: files.length,
            loadedBytes: 0,
            totalBytes: file.size,
            percent: 0,
          },
        }));

        await uploadTerminalFile(terminalId, file, (loadedBytes, totalBytes) => {
          const safeTotal = totalBytes > 0 ? totalBytes : file.size;
          const percent = Math.max(0, Math.min(100, Math.round((loadedBytes / safeTotal) * 100)));
          setTerminalUploadStatuses((prev) => ({
            ...prev,
            [terminalId]: {
              phase: "uploading",
              fileName: file.name,
              fileIndex: index + 1,
              totalFiles: files.length,
              loadedBytes,
              totalBytes: safeTotal,
              percent,
            },
          }));
        });

        setTerminalUploadStatuses((prev) => ({
          ...prev,
          [terminalId]: {
            phase: "finishing",
            fileName: file.name,
            fileIndex: index + 1,
            totalFiles: files.length,
            loadedBytes: file.size,
            totalBytes: file.size,
            percent: 100,
          },
        }));
      }

      setTerminalUploadStatuses((prev) => ({
        ...prev,
        [terminalId]: {
          phase: "done",
          fileName: files[files.length - 1]!.name,
          fileIndex: files.length,
          totalFiles: files.length,
          loadedBytes: files[files.length - 1]!.size,
          totalBytes: files[files.length - 1]!.size,
          percent: 100,
        },
      }));

      setTimeout(() => {
        setTerminalUploadStatuses((prev) => ({
          ...prev,
          [terminalId]: undefined,
        }));
      }, 1800);
    } catch (err) {
      setTerminalUploadStatuses((prev) => ({
        ...prev,
        [terminalId]: undefined,
      }));
      const message = err instanceof Error ? err.message : "Unknown upload error";
      setError(message);
    }
  };

  return (
    <>
      {error && (
        <div className="modal modal-open modal-top z-50">
          <div className="modal-box mt-4 border border-error/40">
            <h3 className="text-lg font-bold text-error">Error</h3>
            <p className="py-2">API error: {error}</p>
            <div className="modal-action mt-2">
              <button className="btn btn-error btn-sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <main data-theme="dark" className="min-h-screen bg-base-200 p-4 md:p-6">
        <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="rounded-box border border-base-300 bg-base-100 p-4 shadow-lg">
            <div className="mb-6">
              <h1 className="text-2xl font-bold">sshCommander</h1>
            </div>

            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
                Tools
              </h2>
              <button
                className="btn btn-primary btn-sm w-full"
                onClick={handleOpenCreateTerminalView}
              >
                New terminal
              </button>
            </div>

            <div className="mt-6 space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
                Terminals
              </h2>

              {terminals.length === 0 ? (
                <p className="text-sm text-base-content/70">No terminals created yet.</p>
              ) : (
                <ul className="space-y-1 rounded-box bg-base-200 p-1">
                  {terminals.map((terminal) => (
                    <li key={terminal.id} className="list-none">
                      <div
                        className={`flex w-full min-w-0 items-start gap-1 rounded px-1 ${selectedTerminalId === terminal.id ? "bg-base-300/50" : ""}`}
                      >
                        <button
                          className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded py-1 text-left hover:bg-base-300/40"
                          onClick={() => {
                            openTerminalWindow(terminal.id);
                          }}
                        >
                          <span className="block w-full truncate text-sm font-medium" title={terminal.name}>
                            {terminal.name}
                          </span>
                          {terminal.type === "local" ? (
                            <span className="badge badge-info badge-xs">local</span>
                          ) : null}
                          <span
                            className="block w-full break-all font-mono text-xs text-base-content/70"
                            title={terminal.id}
                          >
                            {terminal.id}
                          </span>
                        </button>

                        {"ssh" in terminal ? (
                          <button
                            className="btn btn-ghost btn-xs btn-square mt-1"
                            title="Edit terminal config"
                            aria-label={`Edit config for ${terminal.name}`}
                            onClick={() => handleOpenEditTerminalView(terminal)}
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              fill="none"
                              viewBox="0 0 24 24"
                              strokeWidth="1.8"
                              stroke="currentColor"
                              className="h-[18px] w-[18px]"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M10.5 3.75h3a.75.75 0 01.75.75v.74c.533.126 1.037.335 1.5.614l.523-.523a.75.75 0 011.06 0l1.19 1.19a.75.75 0 010 1.06l-.523.523c.28.463.488.967.614 1.5h.74a.75.75 0 01.75.75v3a.75.75 0 01-.75.75h-.74a6.73 6.73 0 01-.614 1.5l.523.523a.75.75 0 010 1.06l-1.19 1.19a.75.75 0 01-1.06 0l-.523-.523a6.732 6.732 0 01-1.5.614v.74a.75.75 0 01-.75.75h-3a.75.75 0 01-.75-.75v-.74a6.732 6.732 0 01-1.5-.614l-.523.523a.75.75 0 01-1.06 0l-1.19-1.19a.75.75 0 010-1.06l.523-.523a6.73 6.73 0 01-.614-1.5h-.74a.75.75 0 01-.75-.75v-3a.75.75 0 01.75-.75h.74c.126-.533.335-1.037.614-1.5l-.523-.523a.75.75 0 010-1.06l1.19-1.19a.75.75 0 011.06 0l.523.523c.463-.28.967-.488 1.5-.614V4.5a.75.75 0 01.75-.75z"
                              />
                              <circle cx="12" cy="12" r="2.25" />
                            </svg>
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          <WorkspacePanel
            isCreateTerminalViewOpen={isCreateTerminalViewOpen}
            editingTerminalId={editingTerminalId}
            createTerminalConfig={createTerminalConfig}
            terminals={terminals}
            openTerminalIds={openTerminalIds}
            terminalOutput={terminalOutput}
            terminalUploadStatuses={terminalUploadStatuses}
            terminalWindowPositions={terminalWindowPositions}
            terminalWindowSizes={terminalWindowSizes}
            terminalZOrder={terminalZOrder}
            onCreateTerminalConfigChange={setCreateTerminalConfig}
            onSaveTerminalConfig={handleSaveTerminalConfig}
            onCancelCreateOrEdit={() => {
              setIsCreateTerminalViewOpen(false);
              setEditingTerminalId(null);
              setCreateTerminalConfig(getDefaultCreateTerminalConfig());
            }}
            onSendRawInput={handleSendRawInput}
            onSshCommanderCommand={handleSshCommanderCommand}
            onSshCommanderComplete={handleSshCommanderComplete}
            onDropFilesToTerminal={handleDropFilesToTerminal}
            onTerminalResize={handleTerminalResize}
            onTerminalPositionChange={(terminalId, position) => {
              setTerminalWindowPositions((prev) => ({
                ...prev,
                [terminalId]: position,
              }));
            }}
            onTerminalSizeChange={(terminalId, nextSize) => {
              setTerminalWindowSizes((prev) => ({
                ...prev,
                [terminalId]: nextSize,
              }));
            }}
            onTerminalFocus={(terminalId) => {
              setSelectedTerminalId(terminalId);
              bringTerminalToFront(terminalId);
            }}
            onTerminalClose={closeTerminalWindow}
          />
        </div>
      </main>
    </>
  );
}

export default App;
