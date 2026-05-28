import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server";
import { normalizeApiKeys, ApiKeyEntry } from "../src/config";
import { ManagedKeyStore } from "../src/keys/store";
import { FileKeyRepository } from "../src/storage/file";

function makeConfig(authDir: string, keys: (string | ApiKeyEntry)[]): any {
  return {
    host: "",
    port: 0,
    "auth-dir": authDir,
    "api-keys": normalizeApiKeys(keys),
    "body-limit": "1mb",
    cloaking: {},
    timeouts: { "messages-ms": 1000, "stream-messages-ms": 1000, "count-tokens-ms": 1000 },
    stats: { enabled: false },
    debug: "off",
  };
}

async function withServer(
  keys: (string | ApiKeyEntry)[],
  fn: (port: number, store: ManagedKeyStore, dir: string) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-adm-"));
  const config = makeConfig(dir, keys);
  const store = new ManagedKeyStore(new FileKeyRepository(dir), config["api-keys"]);
  store.load();
  const app = createServer(config, {} as any, undefined, undefined, store);
  const server = app.listen(0);
  try {
    await fn((server.address() as any).port, store, dir);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const admin: ApiKeyEntry = { key: "sk-admin", enabled: true, admin: true };
const plain: ApiKeyEntry = { key: "sk-plain", enabled: true, admin: false };

test("non-admin key is rejected from /admin/keys with 403", async () => {
  await withServer([admin, plain], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/keys`, {
      headers: { Authorization: "Bearer sk-plain" },
    });
    assert.equal(res.status, 403);
  });
});

test("POST /admin/keys creates a key and returns the raw secret once", async () => {
  await withServer([admin], async (port, store, dir) => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/keys`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ label: "alice", quota: { "monthly-tokens": 1000 } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.key.startsWith("sk-")); // raw key returned once
    assert.equal(body.label, "alice");
    // persisted to managed-keys.json
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "managed-keys.json"), "utf-8"),
    );
    assert.equal(onDisk.length, 1);

    // GET list never exposes the raw key
    const list = await (
      await fetch(`http://127.0.0.1:${port}/admin/keys`, {
        headers: { Authorization: "Bearer sk-admin" },
      })
    ).json();
    assert.ok(!JSON.stringify(list).includes(body.key));
    assert.ok(list.keys.some((k: any) => k.id === body.id && k.source === "managed"));
  });
});

test("created key immediately authenticates against /v1 (live map updated)", async () => {
  await withServer([admin], async (port) => {
    const created = await (
      await fetch(`http://127.0.0.1:${port}/admin/keys`, {
        method: "POST",
        headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    ).json();
    // Use the brand-new key on an inference route — missing `messages` → 400
    // proves it passed auth (would be 403 if the key weren't live).
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    });
    assert.equal(res.status, 400);
  });
});

test("PATCH and DELETE manage a key; DELETE revokes auth", async () => {
  await withServer([admin], async (port) => {
    const created = await (
      await fetch(`http://127.0.0.1:${port}/admin/keys`, {
        method: "POST",
        headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      })
    ).json();

    const patched = await (
      await fetch(`http://127.0.0.1:${port}/admin/keys/${created.id}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "bob@x.com", enabled: false }),
      })
    ).json();
    assert.equal(patched.owner, "bob@x.com");
    assert.equal(patched.enabled, false);

    const del = await fetch(`http://127.0.0.1:${port}/admin/keys/${created.id}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer sk-admin" },
    });
    assert.equal(del.status, 204);
    // revoked → 403 on use
    const use = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    });
    assert.equal(use.status, 403);
  });
});

test("editing a config.yaml key via API returns 409 read_only", async () => {
  await withServer([admin], async (port) => {
    // sk-admin itself is a config key
    const id = require("../src/utils/common").hashApiKey("sk-admin").slice(0, 12);
    const res = await fetch(`http://127.0.0.1:${port}/admin/keys/${id}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.type, "read_only");
  });
});

test("PATCH unknown id returns 404", async () => {
  await withServer([admin], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/admin/keys/ffffffffffff`, {
      method: "PATCH",
      headers: { Authorization: "Bearer sk-admin", "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 404);
  });
});
