import React, { useRef, useState } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderPlus, Home, Trash2, Upload } from "lucide-react";
import { Card, Empty, GhostBtn, PrimaryBtn, T, inputCls } from "./ui.jsx";

export function FileBrowser({ items, loading, error, onAddFolder, onUpload, onDelete, onOpenFile, canWrite, canDelete, rootLabel, emptyHint }) {
  const [folderId, setFolderId] = useState(null);
  const [newFolder, setNewFolder] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const path = [];
  let cur = folderId;
  while (cur) {
    const f = items.find((i) => i.id === cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parent_id;
  }

  const children = items.filter((i) => i.parent_id === folderId);
  const folders = children.filter((i) => i.item_type === "folder");
  const files = children.filter((i) => i.item_type === "file");

  const createFolder = () => {
    const n = (newFolder || "").trim();
    if (n) onAddFolder(n, folderId);
    setNewFolder(null);
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    await onUpload(file, folderId);
    setUploading(false);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 text-sm">
          <button onClick={() => setFolderId(null)} className="flex items-center gap-1 text-content-secondary hover:text-content-primary">
            <Home className="h-3.5 w-3.5" /> {rootLabel}
          </button>
          {path.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-content-muted" />
              <button onClick={() => setFolderId(f.id)} className="text-content-secondary hover:text-content-primary">{f.title}</button>
            </span>
          ))}
        </div>
        {canWrite && (
          <div className="flex items-center gap-2">
            <GhostBtn onClick={() => setNewFolder("")}><FolderPlus className="h-4 w-4" /> New folder</GhostBtn>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
            <PrimaryBtn onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <Upload className="h-4 w-4" /> {uploading ? "Uploading…" : "Upload"}
            </PrimaryBtn>
          </div>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-md border border-danger-border bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {newFolder !== null && (
        <div className="mb-3 flex items-center gap-2">
          <input
            autoFocus
            className={inputCls + " max-w-xs"}
            placeholder="Folder name"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createFolder()}
          />
          <PrimaryBtn onClick={createFolder}>Create</PrimaryBtn>
          <button onClick={() => setNewFolder(null)} className="text-sm text-content-secondary hover:text-content-primary">Cancel</button>
        </div>
      )}

      {loading ? (
        <p className="px-1 py-6 text-center text-sm text-content-muted">Loading…</p>
      ) : folders.length === 0 && files.length === 0 ? (
        <Empty icon={Folder} title="This folder is empty" hint={emptyHint} />
      ) : (
        <div className="space-y-4">
          {folders.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {folders.map((f) => (
                <Card key={f.id} className="group flex items-center gap-3 p-3 hover:border-hairline-strong">
                  <button onClick={() => setFolderId(f.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Folder className="h-5 w-5 flex-shrink-0" style={{ color: T.accent }} />
                    <span className="truncate text-sm font-medium text-content-primary">{f.title}</span>
                  </button>
                  {canDelete && (
                    <button onClick={() => onDelete(f)} className="text-content-muted opacity-0 hover:text-danger group-hover:opacity-100">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </Card>
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {files.map((f) => (
                <Card key={f.id} className="group flex items-start gap-3 p-3">
                  <button onClick={() => onOpenFile(f)} className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-overlay hover:bg-surface-overlay">
                    <FileIcon className="h-4 w-4 text-content-secondary" />
                  </button>
                  <button onClick={() => onOpenFile(f)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-medium text-content-primary hover:underline">{f.title}</p>
                    <p className="text-xs text-content-muted">{f.doc_type}{f.created_at ? " · " + f.created_at.slice(0, 10) : ""}</p>
                  </button>
                  {canDelete && (
                    <button onClick={() => onDelete(f)} className="text-content-muted opacity-0 hover:text-danger group-hover:opacity-100">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
