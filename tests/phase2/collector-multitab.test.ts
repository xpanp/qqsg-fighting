import test from "node:test";
import assert from "node:assert/strict";
import {
  CollectorEnrollment,
  enrollBrowser,
} from "../../frontend/src/sync/enrollment.ts";
const empty = { sourceId: "", token: "" },
  credential = { sourceId: "shared-browser", token: "x".repeat(32) };
test("two tabs share one delayed registration and save before enrollment lock releases", async () => {
  let stored: any,
    requests = 0,
    held = false;
  const events: string[] = [];
  let release!: () => void, entered!: () => void;
  const delayed = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  let tail = Promise.resolve();
  const lock = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
    assert.equal(name, "qqsg-collector-enrollment-v1");
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((r) => (unlock = r));
    await previous;
    assert.equal(held, false);
    held = true;
    events.push("acquire");
    try {
      return await task();
    } finally {
      events.push("release");
      held = false;
      unlock();
    }
  };
  const options = {
    lock,
    read: () => {
      assert.equal(held, true);
      events.push("read");
      return stored;
    },
    save: (value: any) => {
      assert.equal(held, true, "durable save must happen inside lock");
      events.push("save");
      stored = structuredClone(value);
    },
  };
  const fetcher: typeof fetch = async () => {
    requests++;
    events.push("register");
    entered();
    await delayed;
    return Response.json(credential);
  };
  const first = enrollBrowser(
    new CollectorEnrollment({ fetch: fetcher }),
    empty,
    options,
  );
  await started;
  const second = enrollBrowser(
    new CollectorEnrollment({ fetch: fetcher }),
    empty,
    options,
  );
  assert.equal(requests, 1);
  assert.equal(stored, undefined);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.deepEqual(a, { credential, persistent: true });
  assert.deepEqual(b, a);
  assert.deepEqual(events, [
    "acquire",
    "read",
    "register",
    "save",
    "release",
    "acquire",
    "read",
    "save",
    "release",
  ]);
});
test("save failure preserves live credential and explicitly reports persistent false", async () => {
  let released = false;
  const result = await enrollBrowser(
    new CollectorEnrollment({ fetch: async () => Response.json(credential) }),
    empty,
    {
      read: () => undefined,
      save() {
        throw new DOMException("denied", "SecurityError");
      },
      lock: async (_name, task) => {
        try {
          return await task();
        } finally {
          released = true;
        }
      },
    },
  );
  assert.deepEqual(result, { credential, persistent: false });
  assert.equal(released, true);
});
test("existing shared credential wins over stale tab fallback without network registration", async () => {
  let requests = 0;
  const result = await enrollBrowser(
    new CollectorEnrollment({
      fetch: async () => {
        requests++;
        throw Error("must never register");
      },
    }),
    { sourceId: "stale", token: "z".repeat(32) },
    {
      read: () => credential,
      save: (saved) => assert.deepEqual(saved, credential),
      lock: async (_name, task) => task(),
    },
  );
  assert.deepEqual(result, { credential, persistent: true });
  assert.equal(requests, 0);
});

test("main retains nonpersistent warning on subsequent reconnect checks while session stays usable", async () => {
  const { createRequire } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const req = createRequire(import.meta.url),
    ts = req("typescript"),
    { transformSync } = req("esbuild");
  const source = readFileSync(
    new URL("../../frontend/src/app/main.ts", import.meta.url),
    "utf8",
  );
  const parsed = ts.createSourceFile(
      "main.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
    fn = parsed.statements.find(
      (n: any) =>
        ts.isFunctionDeclaration(n) && n.name?.text === "connectCollector",
    );
  assert.ok(fn);
  const code = transformSync(source.slice(fn.getStart(parsed), fn.getEnd()), {
    loader: "ts",
    target: "es2022",
  }).code;
  const text = new Map<string, string>();
  let requests = 0,
    resets = 0;
  const env: any = {
    enrollmentDue: 0,
    syncSettings: { ...empty, enabled: true },
    recorder: {},
    setText: (id: string, s: string) => text.set(id, s),
    navigator: {
      locks: { request: async (_name: string, task: any) => task() },
    },
    enrollBrowser,
    enrollment: new CollectorEnrollment({
      fetch: async () => {
        requests++;
        return Response.json(credential);
      },
    }),
    readCollectorCredential: () => undefined,
    localStorage: {
      setItem() {
        throw new DOMException("blocked", "SecurityError");
      },
    },
    COLLECTOR_STORAGE_KEY: "test",
    sync: {
      reset() {
        resets++;
      },
    },
    describe: String,
  };
  const harness = new Function(
    ...Object.keys(env),
    code + ";return{connectCollector,getSettings:()=>syncSettings};",
  )(...Object.values(env));
  await harness.connectCollector();
  assert.match(text.get("enrollment-status")!, /暂不能持久保存/);
  assert.match(text.get("enrollment-status")!, /本次可用/);
  assert.equal(harness.getSettings().token, credential.token);
  await harness.connectCollector();
  assert.match(text.get("enrollment-status")!, /暂不能持久保存/);
  assert.equal(requests, 1);
  assert.equal(resets, 1);
});
