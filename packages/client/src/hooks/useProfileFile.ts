import { useState, useEffect, useCallback } from "react";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (HTTP ${res.status})`;
}

/**
 * One text file in a profile's game directory, for a raw editor: its
 * content, whether it was edited, save, and the previous version the server
 * kept (restore swaps the two).
 */
export function useProfileFile(profileId: string | undefined, filename: string | undefined) {
  const [content, setContent] = useState("");
  const [saved, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState<{ exists: boolean; mtime?: string } | null>(null);
  const api = profileId && filename ? `/api/profiles/${encodeURIComponent(profileId)}/files/${encodeURIComponent(filename)}` : null;

  const refreshBackup = useCallback(async () => {
    if (!api) return;
    try {
      const res = await fetch(`${api}/backup`, { credentials: "include" });
      setBackup(res.ok ? ((await res.json()) as { exists: boolean; mtime?: string }) : null);
    } catch {
      setBackup(null);
    }
  }, [api]);

  const load = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(api, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { content: string };
        setContent(data.content);
        setSavedContent(data.content);
      } else {
        setError(await errorOf(res, `Could not read ${filename}`));
      }
    } catch {
      setError(`Could not read ${filename}: network error`);
    }
    setLoading(false);
    void refreshBackup();
  }, [api, filename, refreshBackup]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(api, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        setError(await errorOf(res, "Save failed"));
        setBusy(false);
        return false;
      }
      setSavedContent(content);
      void refreshBackup();
      setBusy(false);
      return true;
    } catch {
      setError("Save failed: network error");
      setBusy(false);
      return false;
    }
  }, [api, content, refreshBackup]);

  const restore = useCallback(async (): Promise<boolean> => {
    if (!api) return false;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}/restore`, { method: "POST", credentials: "include" });
      const body = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? "Restore failed");
        setBusy(false);
        return false;
      }
      setContent(body.content ?? "");
      setSavedContent(body.content ?? "");
      void refreshBackup();
      setBusy(false);
      return true;
    } catch {
      setError("Restore failed: network error");
      setBusy(false);
      return false;
    }
  }, [api, refreshBackup]);

  return {
    content,
    setContent,
    dirty: content !== saved,
    loading,
    busy,
    error,
    backup,
    load,
    save,
    restore,
  };
}
