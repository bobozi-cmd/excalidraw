import { useState } from "react";

import "./workspace.scss";

import type { WorkspaceController, WorkspaceSaveStatus } from "./useWorkspace";

const statusText: Record<WorkspaceSaveStatus, string> = {
  local: "本地模式",
  loading: "正在加载",
  saved: "已保存",
  unsaved: "等待保存",
  saving: "正在保存",
  conflict: "版本冲突",
  error: "保存失败",
};

export const WorkspacePanel = ({
  controller,
}: {
  controller: WorkspaceController;
}) => {
  const [workspaceName, setWorkspaceName] = useState("");
  const [password, setPassword] = useState("");

  const createDocument = () => {
    const name = window.prompt("新绘图名称", "未命名绘图")?.trim();
    if (name) {
      void controller.createDocument(name);
    }
  };

  const renameDocument = (documentId: string, currentName: string) => {
    const name = window.prompt("重命名绘图", currentName)?.trim();
    if (name && name !== currentName) {
      void controller.renameDocument(documentId, name);
    }
  };

  const deleteDocument = (documentId: string, name: string) => {
    if (window.confirm(`确定删除“${name}”吗？此操作无法撤销。`)) {
      void controller.deleteDocument(documentId);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`workspace-trigger workspace-trigger--${controller.status}`}
        onClick={() => controller.setPanelOpen(true)}
        title="打开 Workspace"
      >
        <span className="workspace-trigger__dot" />
        <span className="workspace-trigger__label">
          {controller.workspace
            ? `${controller.workspace.name} / ${
                controller.activeDocument?.name || "选择绘图"
              }`
            : "Workspace"}
        </span>
        <span className="workspace-trigger__status">
          {statusText[controller.status]}
        </span>
      </button>

      {controller.panelOpen && (
        <div
          className="workspace-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              controller.setPanelOpen(false);
            }
          }}
        >
          <section
            className="workspace-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace"
          >
            <header className="workspace-panel__header">
              <div>
                <h2>Workspace</h2>
                <p>
                  {controller.workspace
                    ? controller.workspace.name
                    : "在不同设备之间共享多张绘图"}
                </p>
              </div>
              <button
                type="button"
                className="workspace-icon-button"
                onClick={() => controller.setPanelOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </header>

            {controller.message && (
              <div
                className={`workspace-message workspace-message--${controller.status}`}
              >
                {controller.message}
              </div>
            )}

            {!controller.workspace ? (
              <form
                className="workspace-login"
                onSubmit={(event) => {
                  event.preventDefault();
                  void controller.connect(workspaceName, password);
                }}
              >
                <label>
                  Workspace 名称
                  <input
                    autoFocus
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    minLength={2}
                    maxLength={80}
                    required
                    placeholder="例如：个人设计"
                  />
                </label>
                <label>
                  密码
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    maxLength={256}
                    required
                    autoComplete="current-password"
                    placeholder="至少 8 个字符"
                  />
                </label>
                <button
                  type="submit"
                  className="workspace-primary-button"
                  disabled={controller.status === "loading"}
                >
                  {controller.status === "loading" ? "连接中…" : "连接或创建"}
                </button>
                <p className="workspace-hint">
                  不存在的名称会创建新 Workspace；已有名称需要输入正确密码。
                  密码不会保存在浏览器中，登录后仅保存有期限的访问令牌。
                </p>
              </form>
            ) : (
              <>
                {(controller.remoteUpdateAvailable ||
                  controller.status === "conflict") &&
                  controller.activeDocument && (
                    <div className="workspace-conflict">
                      <strong>检测到远端新版本</strong>
                      <p>
                        加载远端会放弃当前未保存修改；覆盖远端会保留当前画布。
                      </p>
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            void controller.loadDocument(
                              controller.activeDocument!.id,
                            )
                          }
                        >
                          加载远端
                        </button>
                        <button
                          type="button"
                          className="workspace-danger-button"
                          onClick={() => void controller.forceSave()}
                        >
                          覆盖远端
                        </button>
                      </div>
                    </div>
                  )}

                <div className="workspace-toolbar">
                  <button type="button" onClick={createDocument}>
                    新建绘图
                  </button>
                  <button
                    type="button"
                    onClick={() => void controller.refresh()}
                  >
                    刷新列表
                  </button>
                  <button
                    type="button"
                    className="workspace-toolbar__disconnect"
                    onClick={() => void controller.disconnect()}
                  >
                    断开 Workspace
                  </button>
                </div>

                <div className="workspace-document-list">
                  {controller.documents.map((document) => (
                    <article
                      key={document.id}
                      className={`workspace-document ${
                        controller.activeDocument?.id === document.id
                          ? "workspace-document--active"
                          : ""
                      }`}
                    >
                      <button
                        type="button"
                        className="workspace-document__open"
                        onClick={() =>
                          void controller.loadDocument(document.id)
                        }
                      >
                        <strong>{document.name}</strong>
                        <span>
                          v{document.version} ·{" "}
                          {new Date(document.updatedAt).toLocaleString()}
                        </span>
                      </button>
                      <div className="workspace-document__actions">
                        <button
                          type="button"
                          onClick={() =>
                            renameDocument(document.id, document.name)
                          }
                          aria-label={`重命名 ${document.name}`}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            deleteDocument(document.id, document.name)
                          }
                          aria-label={`删除 ${document.name}`}
                        >
                          删除
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                <footer className="workspace-panel__footer">
                  <span
                    className={`workspace-status workspace-status--${controller.status}`}
                  >
                    {statusText[controller.status]}
                  </span>
                  <span>每 15 秒检查其他设备的新版本</span>
                </footer>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
};
