import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

const API_BASE = "/api/workspace";

export type WorkspaceInfo = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceDocumentMetadata = {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceScene = {
  type: string;
  version: number;
  source: string;
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

export type WorkspaceDocument = WorkspaceDocumentMetadata & {
  scene: WorkspaceScene;
};

export class WorkspaceApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const request = async <T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const {
      error = "request_failed",
      message = "Workspace 请求失败",
      ...details
    } = data;
    throw new WorkspaceApiError(response.status, error, message, details);
  }
  return data as T;
};

export const workspaceApi = {
  open(name: string, password: string) {
    return request<{
      token: string;
      workspace: WorkspaceInfo;
      documents: WorkspaceDocumentMetadata[];
      created: boolean;
    }>("/session/open", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    });
  },

  resume(token: string) {
    return request<{
      workspace: WorkspaceInfo;
      documents: WorkspaceDocumentMetadata[];
    }>("/session", {}, token);
  },

  createDocument(token: string, name: string) {
    return request<WorkspaceDocument>(
      "/documents",
      { method: "POST", body: JSON.stringify({ name }) },
      token,
    );
  },

  loadDocument(token: string, documentId: string) {
    return request<WorkspaceDocument>(`/documents/${documentId}`, {}, token);
  },

  saveDocument(
    token: string,
    documentId: string,
    version: number,
    scene: WorkspaceScene,
    force = false,
  ) {
    return request<WorkspaceDocumentMetadata>(
      `/documents/${documentId}`,
      {
        method: "PUT",
        body: JSON.stringify({ version, scene, force }),
      },
      token,
    );
  },

  renameDocument(token: string, documentId: string, name: string) {
    return request<WorkspaceDocumentMetadata>(
      `/documents/${documentId}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      token,
    );
  },

  deleteDocument(token: string, documentId: string) {
    return request<{ deleted: true; id: string }>(
      `/documents/${documentId}`,
      { method: "DELETE" },
      token,
    );
  },
};
