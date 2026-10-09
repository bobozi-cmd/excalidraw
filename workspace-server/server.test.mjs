import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createWorkspaceServer } from "./server.mjs";

const startServer = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "excalidraw-workspace-"));
  const server = createWorkspaceServer({
    dataDir,
    tokenSecret: "test-only-token-secret-with-enough-entropy",
    tokenTtlSeconds: 3600,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    dataDir,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
};

const request = async (baseUrl, path, { token, method = "GET", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: await response.json() };
};

test("creates a password-protected workspace and persists documents", async () => {
  const app = await startServer();
  try {
    const opened = await request(app.baseUrl, "/session/open", {
      method: "POST",
      body: { name: "设计团队", password: "correct horse battery staple" },
    });
    assert.equal(opened.response.status, 201);
    assert.equal(opened.data.created, true);
    assert.ok(opened.data.token);

    const created = await request(app.baseUrl, "/documents", {
      method: "POST",
      token: opened.data.token,
      body: { name: "架构图" },
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.data.version, 1);

    const saved = await request(
      app.baseUrl,
      `/documents/${created.data.id}`,
      {
        method: "PUT",
        token: opened.data.token,
        body: {
          version: 1,
          scene: {
            type: "excalidraw",
            version: 2,
            elements: [{ id: "element-1" }],
            appState: {},
            files: {},
          },
        },
      },
    );
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.version, 2);

    const loaded = await request(
      app.baseUrl,
      `/documents/${created.data.id}`,
      { token: opened.data.token },
    );
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.data.scene.elements[0].id, "element-1");
  } finally {
    await app.close();
  }
});

test("rejects wrong passwords and stale document versions", async () => {
  const app = await startServer();
  try {
    const opened = await request(app.baseUrl, "/session/open", {
      method: "POST",
      body: { name: "shared", password: "password-123" },
    });

    const denied = await request(app.baseUrl, "/session/open", {
      method: "POST",
      body: { name: "shared", password: "incorrect-password" },
    });
    assert.equal(denied.response.status, 401);

    const created = await request(app.baseUrl, "/documents", {
      method: "POST",
      token: opened.data.token,
      body: { name: "Drawing" },
    });
    const scene = {
      type: "excalidraw",
      version: 2,
      elements: [],
      appState: {},
      files: {},
    };
    const firstSave = await request(
      app.baseUrl,
      `/documents/${created.data.id}`,
      {
        method: "PUT",
        token: opened.data.token,
        body: { version: 1, scene },
      },
    );
    assert.equal(firstSave.response.status, 200);

    const conflict = await request(
      app.baseUrl,
      `/documents/${created.data.id}`,
      {
        method: "PUT",
        token: opened.data.token,
        body: { version: 1, scene },
      },
    );
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.data.error, "version_conflict");
  } finally {
    await app.close();
  }
});
