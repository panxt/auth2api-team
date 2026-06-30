import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ManagedKeyStore, ManagedKeyError } from "../src/keys/store";
import { FileKeyRepository } from "../src/storage/file";
import { ApiKeyEntry, effectiveRole, canReadAll } from "../src/config";
import { hashApiKey } from "../src/utils/common";

const managedKeysPath = (dir: string) => path.join(dir, "managed-keys.json");
const newStore = (dir: string, live: Map<string, ApiKeyEntry>) =>
  new ManagedKeyStore(new FileKeyRepository(dir), live);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-keys-"));
}

function configMap(keys: ApiKeyEntry[]): Map<string, ApiKeyEntry> {
  return new Map(keys.map((k) => [k.key, k]));
}

test("role: effectiveRole + canReadAll honor role with admin-flag fallback", () => {
  assert.equal(effectiveRole({ role: "auditor" }), "auditor");
  assert.equal(effectiveRole({ admin: true }), "admin"); // legacy fallback
  assert.equal(effectiveRole({ admin: false }), "member");
  assert.equal(canReadAll({ role: "auditor" }), true);
  assert.equal(canReadAll({ role: "admin" }), true);
  assert.equal(canReadAll({ role: "member" }), false);
  assert.equal(canReadAll({ admin: false }), false);
});

test("create: role sets admin flag in sync; auditor is not admin", () => {
  const dir = tmpDir();
  try {
    const store = newStore(dir, configMap([]));
    store.load();
    const auditor = store.create({ label: "qa", role: "auditor" });
    assert.equal(auditor.role, "auditor");
    assert.equal(auditor.admin, false);
    assert.equal(canReadAll(auditor), true);
    const admin = store.create({ label: "boss", role: "admin" });
    assert.equal(admin.admin, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate: reissues a fresh secret, keeps metadata, invalidates the old key", () => {
  const dir = tmpDir();
  try {
    const live = configMap([]);
    const store = newStore(dir, live);
    store.load();
    const orig = store.create({ label: "alice", role: "member", quota: { "monthly-tokens": 50 } });
    const origId = hashApiKey(orig.key).slice(0, 12);

    const rotated = store.rotate(origId);
    assert.notEqual(rotated.key, orig.key); // new secret
    assert.equal(rotated.label, "alice"); // metadata carried
    assert.equal(rotated.role, "member");
    assert.deepEqual(rotated.quota, { "monthly-tokens": 50 });
    assert.equal(live.has(orig.key), false); // old key gone from live map
    assert.equal(live.has(rotated.key), true); // new key live
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rotate: config-sourced key is read-only (cannot self-rotate)", () => {
  const dir = tmpDir();
  try {
    const live = configMap([{ key: "sk-static", enabled: true, admin: false }]);
    const store = newStore(dir, live);
    store.load();
    const id = hashApiKey("sk-static").slice(0, 12);
    assert.throws(() => store.rotate(id), (e) => e instanceof ManagedKeyError && e.code === "read_only");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create: adds a managed key to the live map and persists it", () => {
  const dir = tmpDir();
  try {
    const live = configMap([{ key: "sk-static", enabled: true, admin: false }]);
    const store = newStore(dir, live);
    store.load();
    const created = store.create({ label: "dev", quota: { "monthly-tokens": 100 } });

    assert.ok(created.key.startsWith("sk-"));
    assert.ok(live.has(created.key)); // live map updated → auth works immediately
    const onDisk = JSON.parse(fs.readFileSync(managedKeysPath(dir), "utf-8"));
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].label, "dev");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("load: merges managed-keys.json into live map, managed overrides config", () => {
  const dir = tmpDir();
  try {
    // pre-write a managed key that overrides a config key's policy
    fs.writeFileSync(
      managedKeysPath(dir),
      JSON.stringify([
        { key: "sk-shared", enabled: false, admin: true, label: "managed" },
      ]),
    );
    const live = configMap([{ key: "sk-shared", enabled: true, admin: false }]);
    const store = newStore(dir, live);
    store.load();
    assert.equal(live.get("sk-shared")?.enabled, false); // managed won
    assert.equal(live.get("sk-shared")?.admin, true);
    const view = store.list().find((v) => v.id === hashApiKey("sk-shared").slice(0, 12));
    assert.equal(view?.source, "managed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list: tags config vs managed and never leaks raw keys", () => {
  const dir = tmpDir();
  try {
    const live = configMap([{ key: "sk-static", enabled: true, admin: false }]);
    const store = newStore(dir, live);
    store.load();
    store.create({ label: "m" });
    const views = store.list();
    assert.equal(views.length, 2);
    assert.ok(views.some((v) => v.source === "config"));
    assert.ok(views.some((v) => v.source === "managed"));
    assert.ok(!JSON.stringify(views).includes("sk-static"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update: patches a managed key", () => {
  const dir = tmpDir();
  try {
    const store = newStore(dir, configMap([]));
    const created = store.create({ enabled: true });
    const id = hashApiKey(created.key).slice(0, 12);
    const updated = store.update(id, { enabled: false, owner: "z@x.com" });
    assert.equal(updated.enabled, false);
    assert.equal(updated.owner, "z@x.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete: removes a managed key from live map and disk", () => {
  const dir = tmpDir();
  try {
    const live = configMap([]);
    const store = newStore(dir, live);
    const created = store.create({});
    const id = hashApiKey(created.key).slice(0, 12);
    store.delete(id);
    assert.ok(!live.has(created.key));
    assert.equal(JSON.parse(fs.readFileSync(managedKeysPath(dir), "utf-8")).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update/delete on a config-sourced key is rejected as read_only", () => {
  const dir = tmpDir();
  try {
    const live = configMap([{ key: "sk-static", enabled: true, admin: false }]);
    const store = newStore(dir, live);
    store.load();
    const id = hashApiKey("sk-static").slice(0, 12);
    assert.throws(() => store.update(id, { enabled: false }), (e) => e instanceof ManagedKeyError && (e as ManagedKeyError).code === "read_only");
    assert.throws(() => store.delete(id), (e) => (e as ManagedKeyError).code === "read_only");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update on unknown id throws not_found", () => {
  const dir = tmpDir();
  try {
    const store = newStore(dir, configMap([]));
    assert.throws(() => store.update("deadbeef0000", {}), (e) => (e as ManagedKeyError).code === "not_found");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
