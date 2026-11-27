import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { once } from "node:events";

const binary = process.argv[2];
if (!binary)
  throw Error("Usage: node tests/phase2/run-poc-http.mjs <server.exe>");

async function verify(pattern) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const host = "127.0.0.1:" + socket.address().port;
  socket.close();
  await once(socket, "close");

  const root = resolve(
    process.env.QQSG_TEST_WORK ?? ".tools/phase2-validation",
  );
  await mkdir(root, { recursive: true });
  const runtime = await mkdtemp(join(root, "poc-http-"));
  const keyPath = join(runtime, "local-test-key");
  await writeFile(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
  const base = "http://" + host;
  const password = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    QQSG_ADMIN_PASSWORD: password,
    QQSG_TEST_POC_SERVER: base,
    QQSG_TEST_ADMIN_PASSWORD: password,
  };
  const args = [
    "--data-dir",
    runtime,
    "--listen",
    host,
    "--origin",
    base,
    "--insecure-local",
    "--max-active-collectors",
    "2",
    "--max-report-viewers",
    "2",
  ];
  const logPath = join(runtime, "server.log");
  const log = await open(logPath, "a");
  const logOptions = {
    env,
    stdio: ["ignore", log.fd, log.fd],
    windowsHide: true,
  };
  let server;
  try {
    const init = spawn(resolve(binary), [...args, "--init-admin"], logOptions);
    const [code] = await once(init, "exit");
    if (code !== 0) throw Error("Admin initialization failed");
    async function startServer(argv, sessionPath, expectedStatus) {
      server = spawn(resolve(binary), argv, logOptions);
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        try {
          const response = await fetch(
            base + "/fighting/api/v1/" + sessionPath,
            {
              signal: AbortSignal.timeout(200),
            },
          );
          if (response.status === expectedStatus) return;
        } catch {}
        await new Promise((res) => setTimeout(res, 100));
      }
      throw Error("Local server failed readiness check: " + sessionPath);
    }

    await startServer(args, "admin/session", 401);
    const oldRegistration = await fetch(
      base + "/fighting/api/v1/collectors/register",
      {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    if (!oldRegistration.ok)
      throw Error(
        "Legacy anonymous registration failed: " + oldRegistration.status,
      );
    const { token } = await oldRegistration.json();
    const previousExit = once(server, "exit");
    server.kill();
    await previousExit;

    await startServer(
      [...args, "--account-key-file", keyPath],
      "auth/session",
      200,
    );
    const finished = once(server, "exit");
    const tests = spawn(
      process.execPath,
      [
        "--test",
        "--test-name-pattern",
        pattern,
        "tests/phase2/poc-http.test.mjs",
      ],
      {
        env: {
          ...env,
          QQSG_TEST_POC_LEGACY_TOKEN: token,
          QQSG_TEST_POC_COLLECTOR_LIMIT: "2",
          QQSG_TEST_POC_VIEWER_LIMIT: "2",
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    const [result] = await once(tests, "exit");
    process.exitCode = result ?? 1;
    if (server.exitCode === null) server.kill();
    await finished;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (server?.exitCode === null && server.signalCode === null) server.kill();
    await log.close();
    if (process.exitCode) console.error("See " + logPath);
  }
}

await verify("registration boundaries");
if (!process.exitCode) await verify("collector slots|full report quota");
