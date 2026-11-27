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

test("unknown account observations and unavailable installation storage cannot start collector registration", async () => {
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
  const intents = [{ context: { realm: "" } }];
  let requests = 0;
  const owner = { id: "owner", region: "得陇望蜀" };
  const env = {
    enrollmentDue: 0,
    connecting: false,
    session: { csrf: "session" },
    realm: owner.region,
    businessAccount: () => owner,
    syncSettings: { ...empty, enabled: true },
    setText: (id: string, s: string) => text.set(id, s),
    navigator: {
      locks: { request: async (_name: string, task: () => unknown) => task() },
    },
    request: async () => { requests++; return credential; },
    localStorage: {
      getItem() { return null; },
      setItem() { throw new DOMException("blocked", "SecurityError"); },
    },
    sync: {
      reset() { assert.fail("unavailable storage must not authorize upload"); },
      outbox: { captureIntents: async () => intents, grants: async () => [] },
    },
    describe: String,
  };
  const connect = new Function(
    ...Object.keys(env),
    code + ";return connectCollector;",
  )(...Object.values(env));
  await connect();
  assert.equal(requests, 0);
  assert.equal(text.has("enrollment-status"), false);
  intents.push({ context: { realm: owner.region } });
  await connect();
  assert.equal(requests, 0);
  assert.match(text.get("enrollment-status")!, /本地录像继续/);
});