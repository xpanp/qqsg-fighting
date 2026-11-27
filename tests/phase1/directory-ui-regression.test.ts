import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const req = createRequire(import.meta.url),
  ts = req("typescript"),
  { transformSync } = req("esbuild");
const source = readFileSync(
    new URL("../../frontend/src/app/main.ts", import.meta.url),
    "utf8",
  ),
  parsed = ts.createSourceFile(
    "main.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
const fn = (name: string) => {
  const node = parsed.statements.find(
    (n: any) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert.ok(node);
  return source.slice(node.getStart(parsed), node.getEnd());
};
const handler = parsed.statements.find((n: any) => {
  const e = n.expression;
  return (
    e &&
    ts.isBinaryExpression(e) &&
    ts.isPropertyAccessExpression(e.left) &&
    e.left.name.text === "onclick" &&
    ts.isCallExpression(e.left.expression) &&
    e.left.expression.expression.getText(parsed) === "button" &&
    e.left.expression.arguments[0]?.text === "folder"
  );
});
assert.ok(handler);
function harness(store: any) {
  const nodes = new Map<string, any>(),
    errors: any[] = [],
    notices: any[] = [];
  let constructors = 0,
    crops = 0,
    stops = 0;
  const $ = (id: string) => {
    if (!nodes.has(id))
      nodes.set(id, { disabled: false, classList: { toggle() {} } });
    return nodes.get(id);
  };
  const env: any = {
    store,
    folder: { name: "old" },
    source: {},
    area: {},
    recorder: undefined,
    crop: undefined,
    releaseCaptureLease: undefined,
    starting: false,
    stopping: false,
    checkingFolder: false,
    sessionGeneration: 0,
    $,
    button: $,
    setText() {},
    notify: (...a: any[]) => notices.push(a),
    failure: (e: any) => errors.push(e),
    stop: async () => {
      stops++;
    },
    DurableRecorder: class {
      constructor() {
        constructors++;
      }
    },
    createCrop() {
      crops++;
      throw Error("must not crop");
    },
    navigator: { storage: {} },
    performance,
  };
  const js = transformSync(
    fn("controls") + "\n" + fn("start") + "\n" + handler.getText(parsed),
    { loader: "ts", target: "es2022" },
  ).code;
  const api = new Function(
    ...Object.keys(env),
    js +
      ';controls();return{pick:button("folder").onclick,start,getFolder:()=>folder,checking:()=>checkingFolder};',
  )(...Object.values(env));
  return {
    ...api,
    nodes,
    errors,
    notices,
    get constructors() {
      return constructors;
    },
    get crops() {
      return crops;
    },
    get stops() {
      return stops;
    },
  };
}
test("pending directory validation disables start and does not commit chosen folder until verified", async () => {
  let finish!: (v: any) => void;
  const pending = new Promise((r) => (finish = r)),
    candidate = { name: "new" };
  const f = harness({
    chooseDirectory: async () => candidate,
    verifyDirectoryWritable: () => pending,
  });
  const picking = f.pick();
  await Promise.resolve();
  assert.equal(f.checking(), true);
  assert.equal(f.nodes.get("record").disabled, true);
  assert.equal(f.getFolder(), undefined);
  await f.start();
  assert.equal(f.constructors, 0);
  finish({});
  await picking;
  assert.equal(f.getFolder(), candidate);
  assert.equal(f.checking(), false);
  assert.equal(f.nodes.get("record").disabled, false);
});
test("start recheck rejection precedes database, crop and recorder construction", async () => {
  let databases = 0;
  const denial = new DOMException("revoked", "NotAllowedError");
  const f = harness({
    verifyDirectoryWritable: async () => {
      throw denial;
    },
    database: async () => {
      databases++;
    },
  });
  await assert.rejects(f.start(), (e) => e === denial);
  assert.equal(databases, 0);
  assert.equal(f.constructors, 0);
  assert.equal(f.crops, 0);
  assert.equal(f.getFolder(), undefined);
  assert.equal(
    f.stops,
    0,
    "preparation failure must not wait for old archive shutdown",
  );
  assert.equal(f.nodes.get("record").disabled, true);
});
test("picker cancellation preserves previous folder but write AbortError invalidates it", async () => {
  const abort = new DOMException("cancel", "AbortError");
  const cancelled = harness({
    chooseDirectory: async () => {
      throw abort;
    },
  });
  await cancelled.pick();
  assert.equal(cancelled.getFolder().name, "old");
  assert.equal(cancelled.errors.length, 0);
  const failed = harness({
    chooseDirectory: async () => ({ name: "new" }),
    verifyDirectoryWritable: async () => {
      throw abort;
    },
  });
  await failed.pick();
  assert.equal(failed.getFolder(), undefined);
  assert.equal(failed.errors[0], abort);
  assert.equal(failed.nodes.get("record").disabled, true);
});
