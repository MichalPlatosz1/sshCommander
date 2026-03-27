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
        <label className="form-control w-full">
          <div className="label">
            <span className="label-text">SSH key (paste)</span>
          </div>
          <textarea
            className="textarea textarea-bordered min-h-28 w-full"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            value={config.ssh.sshKey ?? ""}
            onChange={(e) => updateSshField("sshKey", e.target.value)}
          />
        </label>
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
