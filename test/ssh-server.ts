import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import * as ssh2 from "ssh2";

const ssh2Runtime = ssh2 as unknown as {
  Server?: typeof import("ssh2").Client;
  default?: { Server?: typeof import("ssh2").Client };
};
const Server = (ssh2Runtime.default?.Server ??
  ssh2Runtime.Server) as unknown as new (
  config: { hostKeys: string[] },
  connectionListener: (client: any) => void,
) => {
  listen: (port: number, host: string, callback: () => void) => void;
};

const HOST = "127.0.0.1";
const PORT = 2222;
const USERNAME = "test";
const PASSWORD = "test";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: "pkcs1",
    format: "pem",
  },
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
});

function createBaseEnv(extraEnv?: Record<string, string>) {
  return {
    ...process.env,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    ...(extraEnv ?? {}),
  };
}

const server = new Server(
  {
    hostKeys: [privateKey],
  },
  (client: any) => {
    client.on("error", (err: Error) => {
      console.error("[ssh-server] client error:", err.message);
    });

    client.on("authentication", (ctx: any) => {
      if (
        ctx.method === "password" &&
        ctx.username === USERNAME &&
        ctx.password === PASSWORD
      ) {
        return ctx.accept();
      }

      return ctx.reject();
    });

    client.on("ready", () => {
      client.on("session", (accept: any) => {
        const session = accept();
        let ptyInfo: any | null = null;
        let sessionEnv: Record<string, string> = {};

        session.on("pty", (acceptPty: any, _rejectPty: any, info: any) => {
          ptyInfo = info;
          acceptPty();
        });

        session.on("env", (acceptEnv: any, _rejectEnv: any, info: any) => {
          sessionEnv[info.key] = String(info.val ?? "");
          acceptEnv();
        });

        session.on(
          "window-change",
          (_accept: any, _reject: any, _info: any) => {
            // For now we acknowledge changes implicitly via shell process stdio piping.
          },
        );

        session.on("exec", (acceptExec: any, _rejectExec: any, info: any) => {
          const stream = acceptExec();

          const child = spawn("/bin/sh", ["-lc", info.command], {
            env: createBaseEnv(sessionEnv),
          });

          console.log(`[ssh-server] Executing command: ${info.command}`);

          child.stdout.on("data", (chunk: Buffer) => stream.write(chunk));
          child.stderr.on("data", (chunk: Buffer) =>
            stream.stderr.write(chunk),
          );

          // Critical for commands that read stdin (e.g. base64 -d >> file).
          stream.pipe(child.stdin);

          child.stdin.on("error", () => {
            // Ignore broken pipe during shutdown races.
          });

          child.on("close", (code: number | null) => {
            stream.exit(typeof code === "number" ? code : 1);
            stream.end();
          });

          stream.on("close", () => {
            if (!child.killed) {
              child.kill("SIGTERM");
            }
          });
        });

        session.on("shell", (acceptShell: any) => {
          const stream = acceptShell();

          const shellCmd =
            process.platform === "win32" ? "cmd.exe" : "/bin/bash";
          const shellArgs = process.platform === "win32" ? [] : ["-i"];

          const child = spawn(shellCmd, shellArgs, {
            env: createBaseEnv(sessionEnv),
          });

          stream.write("Welcome to sshCommander local test SSH server\r\n");
          if (ptyInfo?.term) {
            stream.write(`PTY: ${ptyInfo.term}\r\n`);
          }

          stream.pipe(child.stdin);
          child.stdout.pipe(stream);
          child.stderr.pipe(stream.stderr);

          child.on("close", (code: number | null) => {
            stream.exit(typeof code === "number" ? code : 0);
            stream.end();
          });

          stream.on("close", () => {
            if (!child.killed) {
              child.kill("SIGTERM");
            }
          });
        });
      });
    });
  },
);

server.listen(PORT, HOST, () => {
  console.log(`Test SSH server running on ${HOST}:${PORT}`);
  console.log(`Login with username='${USERNAME}' and password='${PASSWORD}'`);
});
