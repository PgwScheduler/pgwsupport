import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthProvider.jsx";
import { fileKind, sanitizeFilename } from "../lib/fileKind.js";

function collectDescendantFilePaths(items, folderId) {
  const paths = [];
  const stack = [folderId];
  while (stack.length) {
    const pid = stack.pop();
    for (const item of items.filter((i) => i.parent_id === pid)) {
      if (item.item_type === "folder") stack.push(item.id);
      else if (item.storage_path) paths.push(item.storage_path);
    }
  }
  return paths;
}

function collectDescendantIds(items, folderId) {
  const ids = [];
  const stack = [folderId];
  while (stack.length) {
    const pid = stack.pop();
    for (const item of items.filter((i) => i.parent_id === pid)) {
      ids.push(item.id);
      if (item.item_type === "folder") stack.push(item.id);
    }
  }
  return ids;
}

/* Shared folder-tree file library used by both Documents (per-store) and
   Training (shared, no locationId). Table/bucket names and scope are the
   only things that differ between the two. */
export function useFileLibrary({ table, bucket, locationId = null }) {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchRows = useCallback(async () => {
    if (locationId === undefined) return;
    setLoading(true);
    let query = supabase.from(table).select("*");
    if (locationId) query = query.eq("location_id", locationId);
    const { data, error } = await query
      .order("item_type", { ascending: false }) // folders first
      .order("title", { ascending: true });
    if (error) setError(error.message);
    else {
      setRows(data ?? []);
      setError(null);
    }
    setLoading(false);
  }, [table, locationId]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  const addFolder = useCallback(
    async (title, parentId) => {
      const { data, error } = await supabase
        .from(table)
        .insert({ ...(locationId && { location_id: locationId }), title, item_type: "folder", parent_id: parentId })
        .select()
        .single();
      if (error) {
        setError(error.message);
        return;
      }
      setRows((prev) => [...prev, data]);
    },
    [table, locationId]
  );

  const uploadFile = useCallback(
    async (file, parentId) => {
      const prefix = locationId ? `${locationId}/` : "";
      const path = `${prefix}${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
      const { error: uploadError } = await supabase.storage.from(bucket).upload(path, file);
      if (uploadError) {
        setError(uploadError.message);
        return;
      }
      const { data, error } = await supabase
        .from(table)
        .insert({
          ...(locationId && { location_id: locationId }),
          title: file.name,
          item_type: "file",
          doc_type: fileKind(file.name),
          storage_path: path,
          parent_id: parentId,
          uploaded_by: user?.id,
        })
        .select()
        .single();
      if (error) {
        setError(error.message);
        return;
      }
      setRows((prev) => [...prev, data]);
    },
    [table, bucket, locationId, user?.id]
  );

  const deleteItem = useCallback(
    async (item) => {
      const prevRows = rows;
      if (item.item_type === "file") {
        if (item.storage_path) await supabase.storage.from(bucket).remove([item.storage_path]);
        setRows((prev) => prev.filter((r) => r.id !== item.id));
      } else {
        const filePaths = collectDescendantFilePaths(rows, item.id);
        const descendantIds = new Set([item.id, ...collectDescendantIds(rows, item.id)]);
        if (filePaths.length) await supabase.storage.from(bucket).remove(filePaths);
        setRows((prev) => prev.filter((r) => !descendantIds.has(r.id)));
      }
      const { error } = await supabase.from(table).delete().eq("id", item.id);
      if (error) {
        setError(error.message);
        setRows(prevRows);
      }
    },
    [table, bucket, rows]
  );

  const openFile = useCallback(
    async (item) => {
      if (!item.storage_path) return;
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(item.storage_path, 60);
      if (error) {
        setError(error.message);
        return;
      }
      window.open(data.signedUrl, "_blank");
    },
    [bucket]
  );

  return { rows, loading, error, addFolder, uploadFile, deleteItem, openFile, refetch: fetchRows };
}
