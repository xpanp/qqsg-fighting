import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const base = process.env.QQSG_TEST_POC_SERVER;
const adminPassword = process.env.QQSG_TEST_ADMIN_PASSWORD;
if (base) {
  assert.ok(
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname),
    "Account integration tests require an isolated loopback server",
  );
  assert.ok(adminPassword, "QQSG_TEST_ADMIN_PASSWORD is required");
}

const region = "得陇望蜀";
const password = "N0tGame!123";
const origin = base && new URL(base).origin;
async function request(
  path,
  { method = "GET", body, session, token, csrf = true } = {},
) {
  const headers = { Origin: origin, "Content-Type": "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (csrf && session?.csrf) headers["X-CSRF-Token"] = session.csrf;
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(new URL("/fighting/api/v1/" + path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}
async function success(response) {
  assert.ok(
    response.ok,
    `Expected success, got ${response.status} at ${new URL(response.url).pathname}`,
  );
  return response;
}
function post(path, body, session, extra = {}) {
  return request(path, { method: "POST", body, session, ...extra });
}
async function sessionFor(path, body) {
  const response = await success(await post(path, body));
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Expected session cookie");
  const session = { cookie };
  const state = await (
    await success(await request("auth/session", { session }))
  ).json();
  session.csrf = state.csrf;
  session.user = state.user;
  assert.ok(session.csrf);
  assert.ok(session.user?.role);
  return session;
}
const create = (username) =>
  sessionFor("auth/register", { username, password, region });

test(
  "PoC registration boundaries, password reveal, role revocation and guest policy",
  { skip: !base },
  async () => {
    for (const [username, invalidPassword] of [
      ["abc", password],
      ["x".repeat(17), password],
      ["abc def", password],
      ["战报用户", password],
      ["good", "a".repeat(7)],
      ["good", "a".repeat(19)],
    ]) {
      const response = await post("auth/register", {
        username,
        password: invalidPassword,
        region,
      });
      assert.ok(!response.ok, "An invalid account must not be registered");
    }

    const shortName = randomUUID().slice(0, 4);
    const registered = await create(shortName);
    assert.equal(registered.user.role, "ordinary");
    const longName = randomUUID().replaceAll("-", "").slice(0, 16);
    await create(longName);
    assert.ok(
      !(
        await post("auth/register", {
          username: longName.toUpperCase(),
          password,
          region,
        })
      ).ok,
      "Case-insensitive duplicate registration must fail",
    );

    const admin = await sessionFor("auth/login", {
      username: "admin",
      password: adminPassword,
    });
    assert.equal(admin.user.role, "admin");
    const roster = await success(
      await request("system/users", { session: admin }),
    );
    assert.ok(
      !(await roster.text()).includes(password),
      "User list contains a password",
    );
    assert.ok(!(await request("system/users", { session: registered })).ok);
    assert.ok(!(await request("reports/events", { session: admin })).ok);
    assert.ok(
      !(await request("admin/name-configs", { session: registered })).ok,
    );

    const passwordPath = "system/users/" + registered.user.id + "/password";
    assert.ok(!(await post(passwordPath, {}, registered)).ok);
    assert.ok(!(await post(passwordPath, {}, admin, { csrf: false })).ok);
    const revealed = await success(await post(passwordPath, {}, admin));
    assert.match(revealed.headers.get("cache-control") ?? "", /no-store/i);
    assert.equal((await revealed.json()).password, password);

    const accountPath = "system/users/" + registered.user.id;
    await success(
      await request(accountPath, {
        method: "PATCH",
        body: { role: "super" },
        session: admin,
      }),
    );
    assert.equal(
      (await (await request("auth/session", { session: registered })).json())
        .user,
      null,
      "Changing a role must invalidate old sessions",
    );
    const promoted = await sessionFor("auth/login", {
      username: shortName,
      password,
    });
    assert.equal(promoted.user.role, "super");
    assert.ok(!(await request("system/users", { session: promoted })).ok);
    await success(await request("admin/name-configs", { session: promoted }));

    const guest = await sessionFor("auth/guest", {});
    assert.equal(guest.user.role, "guest");
    assert.ok(
      !(
        await post(
          "collectors/register",
          { installationId: randomUUID(), region },
          guest,
        )
      ).ok,
    );
    await success(await post("reports/lease", { action: "acquire" }, guest));
    await success(await request("reports/events", { session: guest }));

    try {
      await success(
        await request("system/settings", {
          method: "PATCH",
          body: { guestReports: false },
          session: admin,
        }),
      );
      assert.ok(
        !(await request("reports/events", { session: guest })).ok,
        "Guest access toggle must block an existing guest",
      );
    } finally {
      await success(
        await request("system/settings", {
          method: "PATCH",
          body: { guestReports: true },
          session: admin,
        }),
      );
      await success(await post("reports/lease", { action: "release" }, guest));
      await success(
        await request(accountPath, { method: "DELETE", session: admin }),
      );
    }
    assert.equal(
      (await (await request("auth/session", { session: promoted })).json())
        .user,
      null,
      "Deleted accounts must not retain valid sessions",
    );
  },
);

test(
  "collector slots and report sessions are independent and released",
  { skip: !base },
  async () => {
    const legacyToken = process.env.QQSG_TEST_POC_LEGACY_TOKEN;
    if (legacyToken) {
      assert.equal(
        (await request("time", { token: legacyToken })).status,
        401,
        "Legacy anonymous token must not grant access after account migration",
      );
      assert.equal(
        (await post("collectors/register", {})).status,
        401,
        "Anonymous browser cannot register after account migration",
      );
    }
    const limit = Number(process.env.QQSG_TEST_POC_COLLECTOR_LIMIT ?? 10);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
    const accounts = await Promise.all(
      Array.from({ length: limit + 1 }, (_, index) =>
        create("cap" + index + suffix),
      ),
    );
    const blocked = accounts.at(-1);
    const invalid = await post(
      "collectors/register",
      {
        installationId: randomUUID(),
        region: "未知",
      },
      blocked,
    );
    assert.ok(
      !invalid.ok,
      "Unconfirmed region must not be granted a collector",
    );

    const tokens = [];
    for (const account of accounts.slice(0, limit)) {
      const reg = await success(
        await post(
          "collectors/register",
          {
            installationId: randomUUID(),
            region,
          },
          account,
        ),
      );
      const { token } = await reg.json();
      assert.ok(token);
      tokens.push(token);
      await success(
        await post("collectors/lease", { action: "acquire" }, undefined, {
          token,
        }),
      );
    }
    const install = { installationId: randomUUID(), region };
    const blockedRegistration = await post(
      "collectors/register",
      install,
      blocked,
    );
    let pendingToken;
    if (blockedRegistration.ok) {
      pendingToken = (await blockedRegistration.json()).token;
      assert.ok(pendingToken);
      const refused = await post(
        "collectors/lease",
        { action: "acquire" },
        undefined,
        { token: pendingToken },
      );
      assert.equal(refused.status, 429);
    } else {
      assert.equal(blockedRegistration.status, 429);
    }

    await success(await post("reports/lease", { action: "acquire" }, blocked));
    await success(await request("reports/stats", { session: blocked }));

    await success(
      await post("collectors/lease", { action: "release" }, undefined, {
        token: tokens[0],
      }),
    );
    const replacement =
      pendingToken ??
      (
        await (
          await success(await post("collectors/register", install, blocked))
        ).json()
      ).token;
    await success(
      await post("collectors/lease", { action: "acquire" }, undefined, {
        token: replacement,
      }),
    );
    await success(await post("auth/logout", {}, blocked));
    const stale = await post(
      "collectors/lease",
      { action: "renew" },
      undefined,
      { token: replacement },
    );
    assert.ok(!stale.ok, "Logout must revoke collector capability");

    for (const token of tokens.slice(1)) {
      await success(
        await post("collectors/lease", { action: "release" }, undefined, {
          token,
        }),
      );
    }
  },
);

test(
  "full report quota still permits login and does not consume collector quota",
  { skip: !base },
  async () => {
    const limit = Number(process.env.QQSG_TEST_POC_VIEWER_LIMIT ?? 100);
    const sessions = [];
    const admin = await sessionFor("auth/login", {
      username: "admin",
      password: adminPassword,
    });
    await success(
      await request("system/settings", {
        method: "PATCH",
        body: { guestReports: true },
        session: admin,
      }),
    );
    try {
      for (let index = 0; index < limit; index++) {
        const guest = await sessionFor("auth/guest", {});
        await success(
          await post("reports/lease", { action: "acquire" }, guest),
        );
        sessions.push(guest);
      }
      await success(
        await post("reports/lease", { action: "acquire" }, sessions[0]),
      );

      const account = await create("viewer" + randomUUID().slice(0, 8));
      const refused = await post(
        "reports/lease",
        { action: "acquire" },
        account,
      );
      assert.equal(refused.status, 429);
      const { token } = await (
        await success(
          await post(
            "collectors/register",
            { installationId: randomUUID(), region },
            account,
          ),
        )
      ).json();
      await success(
        await post("collectors/lease", { action: "acquire" }, undefined, {
          token,
        }),
      );
      await success(
        await post("collectors/lease", { action: "release" }, undefined, {
          token,
        }),
      );

      await success(
        await post("reports/lease", { action: "release" }, sessions.pop()),
      );
      await success(
        await post("reports/lease", { action: "acquire" }, account),
      );
      sessions.push(account);
    } finally {
      for (const session of sessions) {
        await success(
          await post("reports/lease", { action: "release" }, session),
        );
      }
    }
  },
);
