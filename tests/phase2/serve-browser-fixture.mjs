import { createServer as createNetServer } from "node:net";
/** Serve synthetic capture UI against a disposable local Go database. */
import { createServer as createViteServer } from "vite";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { binary: { type: "string" } } });
if (!values.binary)
  throw Error(
    "Usage: node tests/phase2/serve-browser-fixture.mjs --binary <server.exe>",
  );
// Refuse occupied ports before creating data or touching a backend. Never
// mistake an existing service's health response for this disposable instance.
for (const port of [18782, 18783]) {
  await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", () =>
      reject(
        Error(
          `Port ${port} is occupied; stop only your own test service first`,
        ),
      ),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}
await mkdir(".tools/browser-validation", { recursive: true });
const runtime = await mkdtemp(resolve(".tools/browser-validation/run-"));
const binary = resolve(values.binary),
  origin = "http://127.0.0.1:18783";
const args = [
  "--data-dir",
  runtime,
  "--listen",
  "127.0.0.1:18782",
  "--origin",
  origin,
  "--insecure-local",
];
const log = await open(join(runtime, "backend.log"), "a");
let backend,
  vite,
  closed = false;
async function run(args, env) {
  const child = spawn(binary, args, {
    env,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  return new Promise((r, j) => {
    child.on("error", j);
    child.on("exit", (c) =>
      c
        ? j(Error("backend initialization failed; inspect local backend.log"))
        : r(),
    );
  });
}
async function stop() {
  if (closed) return;
  closed = true;
  await vite?.close();
  if (backend && backend.exitCode === null) {
    backend.kill();
    await new Promise((r) => backend.once("exit", r));
  }
  await log.close();
}
try {
  await run([...args, "--init-admin"], {
    ...process.env,
    QQSG_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
  });
  backend = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  backend.on("error", (e) => {
    console.error(e.message);
    void stop();
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if (
        (await fetch("http://127.0.0.1:18782/fighting/api/v1/admin/session"))
          .status === 401
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error("Isolated backend not ready");
  vite = await createViteServer({
    server: {
      host: "127.0.0.1",
      port: 18783,
      strictPort: true,
      proxy: { "/fighting/api/": "http://127.0.0.1:18782" },
    },
    plugins: [
      {
        name: "local-validation-only",
        configureServer(server) {
          server.middlewares.use("/fighting/_validation/", async (req, res) => {
            if (req.url === "/" || req.url === "") {
              res.setHeader("Content-Type", "text/html;charset=utf-8");
              res.end(
                await readFile("tests/phase2/browser-fixture-harness.html"),
              );
              return;
            }
            res.statusCode = 404;
            res.end();
          });
        },
      },
    ],
  });
  await vite.listen();
  console.log(
    JSON.stringify({
      page: origin + "/fighting/_validation/",
      runtime,
      mode: "synthetic-window-real-mediarecorder-local-only",
    }),
  );
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} catch (error) {
  await stop();
  throw error;
}
