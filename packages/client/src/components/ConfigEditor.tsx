import { useState, useEffect, useCallback } from "react";

interface ConfigEditorProps {}

export function ConfigEditor({}: ConfigEditorProps) {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/config/files", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  const loadFile = async (name: string) => {
    try {
      const res = await fetch(`/api/config/files/${encodeURIComponent(name)}`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setContent(data.content);
        setSelectedFile(name);
        setSaved(false);
      }
    } catch {
      // ignore
    }
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      await fetch(`/api/config/files/${encodeURIComponent(selectedFile)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    }
    setSaving(false);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="bg-amber-900/20 border border-amber-700/30 rounded-md p-2 mb-3">
        <p className="text-xs text-amber-400">
          Changes take effect after server restart
        </p>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <select
          value={selectedFile ?? ""}
          onChange={(e) => e.target.value && loadFile(e.target.value)}
          className="flex-1 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100"
        >
          <option value="">Select a file...</option>
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <button
          onClick={saveFile}
          disabled={!selectedFile || saving}
          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded transition-colors"
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {selectedFile ? (
        <textarea
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setSaved(false);
          }}
          className="flex-1 w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500"
          spellCheck={false}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-zinc-600">
            {files.length === 0
              ? "No config files found"
              : "Select a file to edit"}
          </p>
        </div>
      )}
    </div>
  );
}
