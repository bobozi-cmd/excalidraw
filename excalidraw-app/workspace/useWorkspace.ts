import { useCallback, useEffect, useRef, useState } from "react";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import {
  WorkspaceApiError,
  workspaceApi,
  type WorkspaceDocumentMetadata,
  type WorkspaceInfo,
  type WorkspaceScene,
} from "./api";

const TOKEN_STORAGE_KEY = "excalidraw-workspace-token";
const ACTIVE_DOCUMENT_STORAGE_KEY = "excalidraw-workspace-active-document";
const SAVE_DELAY_MS = 1200;
const REFRESH_INTERVAL_MS = 15000;

export type WorkspaceSaveStatus =
  | "local"
  | "loading"
  | "saved"
  | "unsaved"
  | "saving"
  | "conflict"
  | "error";

const sceneFromEditor = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) =>
  JSON.parse(
    serializeAsJSON(elements, appState, files, "local"),
  ) as WorkspaceScene;

export const useWorkspace = ({
  excalidrawAPI,
  sceneReady,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  sceneReady: boolean;
}) => {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [documents, setDocuments] = useState<WorkspaceDocumentMetadata[]>([]);
  const [activeDocument, setActiveDocument] =
    useState<WorkspaceDocumentMetadata | null>(null);
  const [status, setStatus] = useState<WorkspaceSaveStatus>("local");
  const [message, setMessage] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [remoteUpdateAvailable, setRemoteUpdateAvailable] = useState(false);

  const tokenRef = useRef<string | null>(null);
  const activeDocumentRef = useRef<WorkspaceDocumentMetadata | null>(null);
  const pendingSceneRef = useRef<WorkspaceScene | null>(null);
  const lastSerializedSceneRef = useRef("");
  const applyingRemoteSceneRef = useRef(false);
  const conflictRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);

  const updateDocumentMetadata = useCallback(
    (metadata: WorkspaceDocumentMetadata) => {
      activeDocumentRef.current = metadata;
      setActiveDocument(metadata);
      setDocuments((current) =>
        [
          metadata,
          ...current.filter((document) => document.id !== metadata.id),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    },
    [],
  );

  const savePending = useCallback(
    async (force = false) => {
      if (saveInFlightRef.current) {
        await saveInFlightRef.current;
      }

      const token = tokenRef.current;
      const document = activeDocumentRef.current;
      let scene = pendingSceneRef.current;
      if (!scene && force && excalidrawAPI) {
        scene = sceneFromEditor(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
          excalidrawAPI.getAppState(),
          excalidrawAPI.getFiles(),
        );
      }
      if (!token || !document || !scene) {
        return;
      }

      pendingSceneRef.current = null;
      if (force) {
        conflictRef.current = false;
      }
      setStatus("saving");
      const serialized = JSON.stringify(scene);
      const operation = workspaceApi
        .saveDocument(token, document.id, document.version, scene, force)
        .then((metadata) => {
          updateDocumentMetadata(metadata);
          lastSerializedSceneRef.current = serialized;
          conflictRef.current = false;
          setRemoteUpdateAvailable(false);
          setMessage("");
          setStatus(pendingSceneRef.current ? "unsaved" : "saved");
        })
        .catch((error) => {
          pendingSceneRef.current = scene;
          if (
            error instanceof WorkspaceApiError &&
            error.code === "version_conflict"
          ) {
            conflictRef.current = true;
            const remoteDocument = error.details.document as
              | WorkspaceDocumentMetadata
              | undefined;
            if (remoteDocument) {
              setDocuments((current) =>
                current.map((item) =>
                  item.id === remoteDocument.id ? remoteDocument : item,
                ),
              );
            }
            setRemoteUpdateAvailable(true);
            setStatus("conflict");
            setMessage(
              "这张绘图已在其他设备更新，请选择加载远端版本或覆盖远端。",
            );
            setPanelOpen(true);
          } else {
            setStatus("error");
            setMessage(
              error instanceof Error ? error.message : "保存 Workspace 失败",
            );
          }
        })
        .finally(() => {
          saveInFlightRef.current = null;
        });

      saveInFlightRef.current = operation;
      await operation;

      if (pendingSceneRef.current && !conflictRef.current) {
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = setTimeout(
          () => void savePending(),
          SAVE_DELAY_MS,
        );
      }
    },
    [excalidrawAPI, updateDocumentMetadata],
  );

  const scheduleSave = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (
        !tokenRef.current ||
        !activeDocumentRef.current ||
        applyingRemoteSceneRef.current ||
        conflictRef.current
      ) {
        return;
      }
      const scene = sceneFromEditor(elements, appState, files);
      const serialized = JSON.stringify(scene);
      if (serialized === lastSerializedSceneRef.current) {
        return;
      }
      pendingSceneRef.current = scene;
      setStatus("unsaved");
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(
        () => void savePending(),
        SAVE_DELAY_MS,
      );
    },
    [savePending],
  );

  const loadDocument = useCallback(
    async (documentId: string) => {
      const token = tokenRef.current;
      if (!token || !excalidrawAPI) {
        return;
      }
      if (
        activeDocumentRef.current &&
        activeDocumentRef.current.id !== documentId &&
        status !== "conflict"
      ) {
        await savePending();
      }

      setStatus("loading");
      setMessage("");
      try {
        const document = await workspaceApi.loadDocument(token, documentId);
        const restored = await loadFromBlob(
          new Blob([JSON.stringify(document.scene)], {
            type: "application/json",
          }),
          excalidrawAPI.getAppState(),
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );

        applyingRemoteSceneRef.current = true;
        excalidrawAPI.updateScene({
          elements: restored.elements,
          appState: { ...restored.appState, isLoading: false },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        if (restored.files) {
          excalidrawAPI.addFiles(Object.values(restored.files));
        }
        lastSerializedSceneRef.current = JSON.stringify(document.scene);
        pendingSceneRef.current = null;
        conflictRef.current = false;
        updateDocumentMetadata(document);
        window.localStorage.setItem(ACTIVE_DOCUMENT_STORAGE_KEY, document.id);
        setRemoteUpdateAvailable(false);
        setStatus("saved");
        window.setTimeout(() => {
          applyingRemoteSceneRef.current = false;
        }, 0);
      } catch (error) {
        applyingRemoteSceneRef.current = false;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "加载绘图失败");
      }
    },
    [excalidrawAPI, savePending, status, updateDocumentMetadata],
  );

  const createDocument = useCallback(
    async (name: string) => {
      const token = tokenRef.current;
      if (!token) {
        return;
      }
      try {
        if (activeDocumentRef.current && status !== "conflict") {
          await savePending();
        }
        const document = await workspaceApi.createDocument(token, name);
        setDocuments((current) => [
          document,
          ...current.filter((item) => item.id !== document.id),
        ]);
        await loadDocument(document.id);
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "创建绘图失败");
      }
    },
    [loadDocument, savePending, status],
  );

  const connect = useCallback(
    async (name: string, password: string) => {
      if (!sceneReady || !excalidrawAPI) {
        setMessage("画布仍在初始化，请稍后重试");
        return;
      }
      setStatus("loading");
      setMessage("");
      try {
        const session = await workspaceApi.open(name, password);
        tokenRef.current = session.token;
        window.localStorage.setItem(TOKEN_STORAGE_KEY, session.token);
        setWorkspace(session.workspace);
        setDocuments(session.documents);
        const rememberedId = window.localStorage.getItem(
          ACTIVE_DOCUMENT_STORAGE_KEY,
        );
        const initialDocument =
          session.documents.find((document) => document.id === rememberedId) ||
          session.documents[0];
        if (initialDocument) {
          await loadDocument(initialDocument.id);
        } else {
          await createDocument("未命名绘图");
        }
      } catch (error) {
        tokenRef.current = null;
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        setStatus("local");
        setMessage(
          error instanceof Error ? error.message : "连接 Workspace 失败",
        );
      }
    },
    [createDocument, excalidrawAPI, loadDocument, sceneReady],
  );

  const disconnect = useCallback(async () => {
    if (status !== "conflict") {
      await savePending();
    }
    tokenRef.current = null;
    activeDocumentRef.current = null;
    pendingSceneRef.current = null;
    conflictRef.current = false;
    lastSerializedSceneRef.current = "";
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    window.localStorage.removeItem(ACTIVE_DOCUMENT_STORAGE_KEY);
    setWorkspace(null);
    setDocuments([]);
    setActiveDocument(null);
    setRemoteUpdateAvailable(false);
    setMessage("");
    setStatus("local");
  }, [savePending, status]);

  const renameDocument = useCallback(
    async (documentId: string, name: string) => {
      const token = tokenRef.current;
      if (!token) {
        return;
      }
      try {
        const metadata = await workspaceApi.renameDocument(
          token,
          documentId,
          name,
        );
        setDocuments((current) =>
          current.map((document) =>
            document.id === metadata.id ? metadata : document,
          ),
        );
        if (activeDocumentRef.current?.id === metadata.id) {
          updateDocumentMetadata(metadata);
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "重命名绘图失败");
      }
    },
    [updateDocumentMetadata],
  );

  const deleteDocument = useCallback(
    async (documentId: string) => {
      const token = tokenRef.current;
      if (!token) {
        return;
      }
      try {
        await workspaceApi.deleteDocument(token, documentId);
        const remaining = documents.filter(
          (document) => document.id !== documentId,
        );
        setDocuments(remaining);
        if (activeDocumentRef.current?.id === documentId) {
          activeDocumentRef.current = null;
          setActiveDocument(null);
          if (remaining[0]) {
            await loadDocument(remaining[0].id);
          } else {
            await createDocument("未命名绘图");
          }
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "删除绘图失败");
      }
    },
    [createDocument, documents, loadDocument],
  );

  const refresh = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) {
      return;
    }
    try {
      const session = await workspaceApi.resume(token);
      setWorkspace(session.workspace);
      setDocuments(session.documents);
      const remoteActive = session.documents.find(
        (document) => document.id === activeDocumentRef.current?.id,
      );
      if (
        remoteActive &&
        activeDocumentRef.current &&
        remoteActive.version > activeDocumentRef.current.version
      ) {
        setRemoteUpdateAvailable(true);
        setMessage("检测到其他设备保存的新版本。");
      }
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.status === 401) {
        await disconnect();
        setMessage(error.message);
      }
    }
  }, [disconnect]);

  const forceSave = useCallback(async () => {
    setRemoteUpdateAvailable(false);
    setMessage("");
    setStatus("unsaved");
    await savePending(true);
  }, [savePending]);

  useEffect(() => {
    if (!sceneReady || !excalidrawAPI || tokenRef.current) {
      return;
    }
    const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) {
      return;
    }
    tokenRef.current = token;
    setStatus("loading");
    workspaceApi
      .resume(token)
      .then(async (session) => {
        setWorkspace(session.workspace);
        setDocuments(session.documents);
        const rememberedId = window.localStorage.getItem(
          ACTIVE_DOCUMENT_STORAGE_KEY,
        );
        const initialDocument =
          session.documents.find((document) => document.id === rememberedId) ||
          session.documents[0];
        if (initialDocument) {
          await loadDocument(initialDocument.id);
        } else {
          await createDocument("未命名绘图");
        }
      })
      .catch((error) => {
        tokenRef.current = null;
        window.localStorage.removeItem(TOKEN_STORAGE_KEY);
        setStatus("local");
        setMessage(
          error instanceof Error ? error.message : "Workspace 会话已失效",
        );
      });
  }, [createDocument, excalidrawAPI, loadDocument, sceneReady]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    const interval = window.setInterval(
      () => void refresh(),
      REFRESH_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [refresh, workspace]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && status !== "conflict") {
        void savePending();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [savePending, status]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    },
    [],
  );

  return {
    workspace,
    documents,
    activeDocument,
    status,
    message,
    panelOpen,
    remoteUpdateAvailable,
    setPanelOpen,
    setMessage,
    connect,
    disconnect,
    createDocument,
    loadDocument,
    renameDocument,
    deleteDocument,
    refresh,
    forceSave,
    scheduleSave,
  };
};

export type WorkspaceController = ReturnType<typeof useWorkspace>;
