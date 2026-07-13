import React from "react";
import { useAuth } from "../context/AuthProvider.jsx";
import { useFileLibrary } from "../hooks/useFileLibrary.js";
import { SectionHeader } from "./ui.jsx";
import { FileBrowser } from "./FileBrowser.jsx";

export function DocumentsView({ store }) {
  const { role } = useAuth();
  const { rows, loading, error, addFolder, uploadFile, deleteItem, openFile } = useFileLibrary({
    table: "documents",
    bucket: "documents",
    locationId: store.id,
  });

  return (
    <div>
      <SectionHeader title="Documents" subtitle={store.name} />
      <FileBrowser
        items={rows}
        loading={loading}
        error={error}
        onAddFolder={addFolder}
        onUpload={uploadFile}
        onDelete={deleteItem}
        onOpenFile={openFile}
        canWrite
        canDelete={role === "master"}
        rootLabel="Documents"
        emptyHint="Add a folder or upload this store's paperwork."
      />
    </div>
  );
}
