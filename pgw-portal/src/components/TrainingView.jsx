import React from "react";
import { useAuth } from "../context/AuthProvider.jsx";
import { useFileLibrary } from "../hooks/useFileLibrary.js";
import { SectionHeader } from "./ui.jsx";
import { FileBrowser } from "./FileBrowser.jsx";

export function TrainingView() {
  const { role } = useAuth();
  const { rows, loading, error, addFolder, uploadFile, deleteItem, openFile } = useFileLibrary({
    table: "training",
    bucket: "training",
  });
  const canWrite = role === "admin" || role === "master";

  return (
    <div>
      <SectionHeader title="Training" subtitle="Shared library — same for every store" />
      <FileBrowser
        items={rows}
        loading={loading}
        error={error}
        onAddFolder={addFolder}
        onUpload={uploadFile}
        onDelete={deleteItem}
        onOpenFile={openFile}
        canWrite={canWrite}
        canDelete={canWrite}
        rootLabel="Training"
        emptyHint="Add a folder or upload training material."
      />
    </div>
  );
}
