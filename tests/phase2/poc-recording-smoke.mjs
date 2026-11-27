/** Real MediaRecorder, synthetic window/OPFS, isolated account HTTP fixtures. */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const fixture = await readFile(
  new URL("./browser-fixture-harness.html", import.meta.url),
);
const vite = await createServer({
  configFile: false,
  root: "frontend",
  base: "/fighting/",
  cacheDir: await mkdtemp(join(tmpdir(), "qqsg-recording-test-")),
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  plugins: [
    {
      name: "poc-recording-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/fighting/recording-test.html") return next();
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.end(fixture);
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  const port = vite.httpServer.address().port;
  const profile = await mkdtemp(
    join(process.env.QQSG_TEST_BROWSER_WORK ?? tmpdir(), "qqsg-edge-"),
  );
  browser = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.QQSG_TEST_EDGE ??
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    args: ["--disable-gpu", "--disable-crash-reporter"],
    viewport: { width: 1440, height: 1050 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const user = {
    id: "recording-owner",
    username: "recording-owner",
    region: "得陇望蜀",
    role: "ordinary",
  };
  let signedIn = true;
  let quotaResponses = 0;
  await page.route("**/fighting/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/auth/session")) {
      return route.fulfill({
        json: {
          user: signedIn ? user : null,
          csrf: "fixture-csrf",
          guestReports: true,
        },
      });
    }
    if (path.endsWith("/auth/logout")) {
      signedIn = false;
      return route.fulfill({ json: { ok: true } });
    }
    quotaResponses++;
    return route.fulfill({
      status: 429,
      headers: { "Retry-After": "30" },
      json: { error: "fixture capacity reached" },
    });
  });
  await page.goto(`http://127.0.0.1:${port}/fighting/recording-test.html`);
  await page.locator("#folder").click();
  await page.locator("#share").click();
  await page.locator("#preview").waitFor();
  await page.locator("#fixture-select").click();
  await page.locator("#record").click();
  await page.waitForFunction(() => !document.querySelector("#stop").disabled);
  await page.waitForFunction(() =>
    document
      .querySelector("#capture-identity")
      .textContent.includes("得陇望蜀"),
  );
  for (let i = 0; !quotaResponses && i < 40; i++)
    await page.waitForTimeout(500);
  assert.ok(
    quotaResponses,
    "Recording did not exercise a real UI quota response",
  );
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page
    .getByText("登录已结束。请停止并保存当前录制，再登录其他账号。")
    .waitFor();
  assert.ok(
    await page.locator("#recording-area").isVisible(),
    "Logout unmounted the recorder",
  );
  assert.ok(
    await page.locator("#stop").isEnabled(),
    "Logout blocked manual stop",
  );

  await page.waitForFunction(
    () => document.querySelector("#segments").textContent.includes("已保存"),
    null,
    { timeout: 75000 },
  );
  assert.ok(
    await page.locator("#stop").isEnabled(),
    "Recorder did not continue after first segment",
  );
  await page.locator("#stop").click();
  await page.locator("#recording-area").waitFor({ state: "hidden" });
  await page.locator("#fixture-check").click();
  const files = await page
    .waitForFunction(
      () => {
        try {
          const details = JSON.parse(
            document.querySelector("#validation-status").textContent,
          );
          const videos = details.files.filter(
            ({ name, size }) => name.endsWith(".webm") && size > 0,
          );
          return videos.length >= 2 ? videos : undefined;
        } catch {}
      },
      null,
      { timeout: 10000 },
    )
    .then((result) => result.jsonValue());
  assert.ok(
    files.every(({ width, height }) => width && height),
    "Saved segment is not decodable",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      quotaResponses,
      segments: files.length,
      dimensions: files.map(({ width, height }) => [width, height]),
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
}
