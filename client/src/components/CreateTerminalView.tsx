import { useRef, useState } from "react";

type SshAuthMethod = "password" | "sshKey";

type CreateTerminalConfig = {
  name: string;
  ssh: {
    targetUser: string;
    targetMachine: string;
    targetPort: number;
    authMethod: SshAuthMethod;
    password?: string;
    sshKey?: string;
  };
};

type CreateTerminalViewProps = {
  config: CreateTerminalConfig;
  onConfigChange: (value: CreateTerminalConfig) => void;
  onCreateTerminal: () => void;
  onCancel: () => void;
  title?: string;
  submitLabel?: string;
};

function CreateTerminalView({
  config,
  onConfigChange,
  onCreateTerminal,
  onCancel,
  title = "Create terminal",
  submitLabel = "Create terminal",
}: CreateTerminalViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadingKeyFile, setLoadingKeyFile] = useState(false);
  const [keyFileError, setKeyFileError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);

  const updateSshField = (
    field: keyof CreateTerminalConfig["ssh"],
    value: string | number | SshAuthMethod,
  ) => {
    onConfigChange({
      ...config,
      ssh: {
        ...config.ssh,
        [field]: value,
      },
    });
  };

  const handleLoadSshKeyFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoadingKeyFile(true);
    setKeyFileError(null);
    setSelectedFileName(null);

    try {
      const formData = new FormData();
      formData.append("keyFile", file);

      const response = await fetch("/api/ssh-keys/load", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to load SSH key");
      }

      const data = await response.json();
      updateSshField("sshKey", data.keyContent);
      setSelectedFileName(file.name);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error loading SSH key";
      setKeyFileError(message);
    } finally {
      setLoadingKeyFile(false);
      // Clear the input so selecting the same file again will trigger onChange
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="text-base-content/70">Configure terminal details.</p>

      <label className="form-control w-full">
        <div className="label">
          <span className="label-text">Terminal name</span>
        </div>
        <input
          type="text"
          className="input input-bordered w-full"
          placeholder="e.g. Production SSH"
          value={config.name}
          onChange={(e) => onConfigChange({ ...config, name: e.target.value })}
        />
      </label>

      <label className="form-control w-full">
        <div className="label">
          <span className="label-text">Target user</span>
        </div>
        <input
          type="text"
          className="input input-bordered w-full"
          placeholder="e.g. deploy"
          value={config.ssh.targetUser}
          onChange={(e) => updateSshField("targetUser", e.target.value)}
        />
      </label>

      <label className="form-control w-full">
        <div className="label">
          <span className="label-text">Target machine (IP or domain)</span>
        </div>
        <input
          type="text"
          className="input input-bordered w-full"
          placeholder="e.g. 10.10.0.12 or server.example.com"
          value={config.ssh.targetMachine}
          onChange={(e) => updateSshField("targetMachine", e.target.value)}
        />
      </label>

      <label className="form-control w-full">
        <div className="label">
          <span className="label-text">Target port</span>
        </div>
        <input
          type="number"
          min={1}
          max={65535}
          className="input input-bordered w-full"
          placeholder="22"
          value={config.ssh.targetPort}
          onChange={(e) => updateSshField("targetPort", Number(e.target.value))}
        />
      </label>

      <div className="form-control">
        <div className="label">
          <span className="label-text">Authentication</span>
        </div>
        <div className="join">
          <button
            type="button"
            className={`btn join-item btn-sm ${config.ssh.authMethod === "password" ? "btn-primary" : "btn-outline"}`}
            onClick={() => updateSshField("authMethod", "password")}
          >
            Password
          </button>
          <button
            type="button"
            className={`btn join-item btn-sm ${config.ssh.authMethod === "sshKey" ? "btn-primary" : "btn-outline"}`}
            onClick={() => updateSshField("authMethod", "sshKey")}
          >
            SSH key
          </button>
        </div>
      </div>

      {config.ssh.authMethod === "password" ? (
        <label className="form-control w-full">
          <div className="label">
            <span className="label-text">Password</span>
          </div>
          <input
            type="password"
            className="input input-bordered w-full"
            placeholder="Password"
            value={config.ssh.password ?? ""}
            onChange={(e) => updateSshField("password", e.target.value)}
          />
        </label>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="label">
              <span className="label-text">SSH key</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={loadingKeyFile}
              >
                {loadingKeyFile ? "Loading..." : "Load from file"}
              </button>
              {selectedFileName && (
                <span className="text-sm text-success flex items-center">
                  ✓ {selectedFileName}
                </span>
              )}
            </div>
            {keyFileError && (
              <p className="text-sm text-error mt-2">{keyFileError}</p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleLoadSshKeyFile}
              accept=".pem,.key,.pub,text/plain"
            />
          </div>

          <div>
            <div className="label">
              <span className="label-text">Or paste SSH key</span>
            </div>
            <textarea
              className="textarea textarea-bordered min-h-28 w-full"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              value={config.ssh.sshKey ?? ""}
              onChange={(e) => updateSshField("sshKey", e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={onCreateTerminal}>
          {submitLabel}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default CreateTerminalView;
