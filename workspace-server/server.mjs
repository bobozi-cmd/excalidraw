import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const MAX_AUTH_ATTEMPTS = 12;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const nowIso = () => new Date().toISOString();

const sendJson = (response, status, data) => {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(body);
};

const readJson = async (request) => {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "请求内容超过 50MB 限制");
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "payload_too_large", "请求内容超过 50MB 限制");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "请求不是有效的 JSON");
  }
};

const normalizeWorkspaceName = (value) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_workspace", "Workspace 名称不能为空");
  }
  const displayName = value.normalize("NFKC").trim();
  if (displayName.length < 2 || displayName.length > 80) {
    throw new HttpError(400, "invalid_workspace", "Workspace 名称长度应为 2 到 80 个字符");
  }
  if (/\p{Cc}/u.test(displayName)) {
    throw new HttpError(400, "invalid_workspace", "Workspace 名称不能包含控制字符");
  }
  return {
    displayName,
    normalizedName: displayName.toLocaleLowerCase("en-US"),
  };
};

const validatePassword = (value) => {
  if (typeof value !== "string" || value.length < 8 || value.length > 256) {
    throw new HttpError(400, "invalid_password", "Workspace 密码长度应为 8 到 256 个字符");
  }
  return value;
};

const validateDocumentName = (value) => {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_document_name", "绘图名称不能为空");
  }
  const name = value.normalize("NFKC").trim();
  if (!name || name.length > 120 || /\p{Cc}/u.test(name)) {
    throw new HttpError(400, "invalid_document_name", "绘图名称长度应为 1 到 120 个字符");
  }
  return name;
};

const validateScene = (scene) => {
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) {
    throw new HttpError(400, "invalid_scene", "绘图数据格式无效");
  }
  if (!scene.appState || typeof scene.appState !== "object") {
    throw new HttpError(400, "invalid_scene", "绘图缺少 appState");
  }
  if (scene.files && typeof scene.files !== "object") {
    throw new HttpError(400, "invalid_scene", "绘图 files 格式无效");
  }
  return scene;
};

const emptyScene = () => ({
  type: "excalidraw",
  version: 2,
  source: "self-hosted-workspace",
  elements: [],
  appState: {},
  files: {},
});

const workspaceIdFor = (normalizedName) =>
  createHash("sha256").update(normalizedName).digest("hex");

const documentMetadata = (document) => ({
  id: document.id,
  name: document.name,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

const publicWorkspace = (workspace) => ({
  id: workspace.id,
  name: workspace.name,
  createdAt: workspace.createdAt,
  updatedAt: workspace.updatedAt,
});

const loadOrCreateSecret = (dataDir, suppliedSecret) => {
  if (suppliedSecret) {
    return Buffer.from(suppliedSecret);
  }
  const secretPath = join(dataDir, ".server-secret");
  if (existsSync(secretPath)) {
    return Buffer.from(readFileSync(secretPath, "utf8").trim(), "base64url");
  }
  const secret = randomBytes(32);
  writeFileSync(secretPath, secret.toString("base64url"), { mode: 0o600 });
  return secret;
};

const hashPassword = async (password, salt) =>
  Buffer.from(await scrypt(password, salt, 64)).toString("base64url");

const verifyPassword = async (workspace, password) => {
  const actual = Buffer.from(
    await scrypt(password, Buffer.from(workspace.passwordSalt, "base64url"), 64),
  );
  const expected = Buffer.from(workspace.passwordHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createWorkspaceServer = ({
  dataDir = process.env.DATA_DIR || "/data",
  tokenSecret,
  tokenTtlSeconds = TOKEN_TTL_SECONDS,
} = {}) => {
  mkdirSync(dataDir, { recursive: true });
  const signingSecret = loadOrCreateSecret(dataDir, tokenSecret);
  const authAttempts = new Map();

  const workspacePath = (workspaceId) => join(dataDir, `${workspaceId}.json`);

  const loadWorkspace = (workspaceId) => {
    const filePath = workspacePath(workspaceId);
    if (!existsSync(filePath)) {
      throw new HttpError(404, "workspace_not_found", "Workspace 不存在");
    }
    return JSON.parse(readFileSync(filePath, "utf8"));
  };

  const saveWorkspace = (workspace) => {
    workspace.updatedAt = nowIso();
    const filePath = workspacePath(workspace.id);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(workspace), { mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  };

  const issueToken = (workspaceId) => {
    const payload = Buffer.from(
      JSON.stringify({
        workspaceId,
        expiresAt: Math.floor(Date.now() / 1000) + tokenTtlSeconds,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", signingSecret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  };

  const verifyToken = (request) => {
    const authorization = request.headers.authorization || "";
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    const [payload, signature] = token.split(".");
    if (!payload || !signature) {
      throw new HttpError(401, "unauthorized", "请重新连接 Workspace");
    }
    const expectedSignature = createHmac("sha256", signingSecret)
      .update(payload)
      .digest();
    let actualSignature;
    try {
      actualSignature = Buffer.from(signature, "base64url");
    } catch {
      throw new HttpError(401, "unauthorized", "Workspace 会话无效");
    }
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      throw new HttpError(401, "unauthorized", "Workspace 会话无效");
    }
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new HttpError(401, "unauthorized", "Workspace 会话无效");
    }
    if (
      typeof decoded.workspaceId !== "string" ||
      !Number.isFinite(decoded.expiresAt) ||
      decoded.expiresAt <= Math.floor(Date.now() / 1000)
    ) {
      throw new HttpError(401, "token_expired", "Workspace 会话已过期，请重新输入密码");
    }
    return decoded.workspaceId;
  };

  const checkAuthRateLimit = (request) => {
    const key = request.socket.remoteAddress || "unknown";
    const cutoff = Date.now() - AUTH_WINDOW_MS;
    const attempts = (authAttempts.get(key) || []).filter(
      (timestamp) => timestamp > cutoff,
    );
    if (attempts.length >= MAX_AUTH_ATTEMPTS) {
      throw new HttpError(429, "too_many_attempts", "密码尝试过多，请稍后再试");
    }
    attempts.push(Date.now());
    authAttempts.set(key, attempts);
    return () => authAttempts.delete(key);
  };

  const handler = async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://workspace.local");

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { status: "ok" });
      }

      if (request.method === "POST" && url.pathname === "/session/open") {
        const clearAttempts = checkAuthRateLimit(request);
        const body = await readJson(request);
        const { displayName, normalizedName } = normalizeWorkspaceName(body.name);
        const password = validatePassword(body.password);
        const workspaceId = workspaceIdFor(normalizedName);
        let workspace;
        let created = false;

        if (existsSync(workspacePath(workspaceId))) {
          workspace = loadWorkspace(workspaceId);
          if (!(await verifyPassword(workspace, password))) {
            throw new HttpError(401, "invalid_credentials", "Workspace 名称或密码错误");
          }
        } else {
          const passwordSalt = randomBytes(16);
          const timestamp = nowIso();
          workspace = {
            schemaVersion: 1,
            id: workspaceId,
            name: displayName,
            normalizedName,
            passwordSalt: passwordSalt.toString("base64url"),
            passwordHash: await hashPassword(password, passwordSalt),
            createdAt: timestamp,
            updatedAt: timestamp,
            documents: {},
          };
          saveWorkspace(workspace);
          created = true;
        }

        clearAttempts();
        return sendJson(response, created ? 201 : 200, {
          token: issueToken(workspace.id),
          workspace: publicWorkspace(workspace),
          documents: Object.values(workspace.documents)
            .map(documentMetadata)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          created,
        });
      }

      const workspaceId = verifyToken(request);
      const workspace = loadWorkspace(workspaceId);

      if (request.method === "GET" && url.pathname === "/session") {
        return sendJson(response, 200, {
          workspace: publicWorkspace(workspace),
          documents: Object.values(workspace.documents)
            .map(documentMetadata)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        });
      }

      if (request.method === "POST" && url.pathname === "/documents") {
        const body = await readJson(request);
        const timestamp = nowIso();
        const document = {
          id: randomUUID(),
          name: validateDocumentName(body.name || "未命名绘图"),
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          scene: emptyScene(),
        };
        workspace.documents[document.id] = document;
        saveWorkspace(workspace);
        return sendJson(response, 201, document);
      }

      const match = url.pathname.match(/^\/documents\/([0-9a-f-]{36})$/i);
      if (!match) {
        throw new HttpError(404, "not_found", "接口不存在");
      }
      const document = workspace.documents[match[1]];
      if (!document) {
        throw new HttpError(404, "document_not_found", "绘图不存在");
      }

      if (request.method === "GET") {
        return sendJson(response, 200, document);
      }

      if (request.method === "PATCH") {
        const body = await readJson(request);
        document.name = validateDocumentName(body.name);
        document.updatedAt = nowIso();
        saveWorkspace(workspace);
        return sendJson(response, 200, documentMetadata(document));
      }

      if (request.method === "PUT") {
        const body = await readJson(request);
        if (!Number.isInteger(body.version) || body.version < 1) {
          throw new HttpError(400, "invalid_version", "缺少有效的绘图版本");
        }
        if (!body.force && body.version !== document.version) {
          throw new HttpError(409, "version_conflict", "绘图已在其他设备上更新", {
            document: documentMetadata(document),
          });
        }
        document.scene = validateScene(body.scene);
        document.version += 1;
        document.updatedAt = nowIso();
        saveWorkspace(workspace);
        return sendJson(response, 200, documentMetadata(document));
      }

      if (request.method === "DELETE") {
        delete workspace.documents[document.id];
        saveWorkspace(workspace);
        return sendJson(response, 200, { deleted: true, id: document.id });
      }

      throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
    } catch (error) {
      if (error instanceof HttpError) {
        return sendJson(response, error.status, {
          error: error.code,
          message: error.message,
          ...(error.details || {}),
        });
      }
      console.error(error);
      return sendJson(response, 500, {
        error: "internal_error",
        message: "Workspace 服务发生内部错误",
      });
    }
  };

  return createServer(handler);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3001);
  const server = createWorkspaceServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Excalidraw workspace server listening on ${port}`);
  });
}
