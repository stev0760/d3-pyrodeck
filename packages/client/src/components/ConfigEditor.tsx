import { useState, useEffect, useCallback } from "react";
import type { ServerProfile } from "../hooks/useLauncher.ts";

interface ConfigEditorProps {
  profiles: ServerProfile[];
  onRefreshProfiles: () => void;
}

/** File type definition for the sectioned layout. */
interface FileSection {
  key: string;
  label: string;
  description: string;
  /** Resolve the filename for this section given the profile. */
  filename: (profile: ServerProfile) => string;
  /** Can this file be created from scratch? */
  canCreate: boolean;
}

const FILE_SECTIONS: FileSection[] = [
  {
    key: "cfg",
    label: "Server Config",
    description: "Main dedicated server settings — game type, network, rules, telnet.",
    filename: (p) => p.configFile,
    canCreate: false, // Always exists (created with profile)
  },
  {
    key: "mps",
    label: "Ship Settings",
    description: "Controls which ships are allowed or banned. Referenced via MultiSettingsFile in server config.",
    filename: () => "companion.mps",
    canCreate: true,
  },
  {
    key: "bots",
    label: "Bot Roster",
    description: "Bot names, ships, and difficulty levels. Matcen fork only — requires BotConfig in server config.",
    filename: () => "bots.cfg",
    canCreate: true,
  },
  {
    key: "dmfc",
    label: "Startup Commands",
    description: "DMFC commands run automatically after server initializes (e.g., $serverhudnames, $killmsgfilter).",
    filename: () => "autoexec.dmfc",
    canCreate: true,
  },
];

/** Default content for newly created companion files. */
const DEFAULT_CONTENT: Record<string, string> = {
  "companion.mps": "[multi settings file]\n",
  "bots.cfg":
    "BotCount=0\nBotDifficulty=2\n",
  "autoexec.dmfc": "",
};

export function ConfigEditor({ profiles, onRefreshProfiles }: ConfigEditorProps) {
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [activeSection, setActiveSection] = useState<string>("cfg");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileExists, setFileExists] = useState<Record<string, boolean>>({});
  // Existing game config files for the import section
  const [gameFiles, setGameFiles] = useState<string[]>([]);
  const [showImport, setShowImport] = useState(false);

  // Auto-select first profile
  useEffect(() => {
    if (profiles.length > 0 && !selectedProfileId) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  // Probe which companion files exist when profile changes
  useEffect(() => {
    if (!selectedProfile) {
      setFileExists({});
      return;
    }

    const checkFiles = async () => {
      const results: Record<string, boolean> = {};
      for (const section of FILE_SECTIONS) {
        const filename = section.filename(selectedProfile);
        try {
          const res = await fetch(
            `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(filename)}`,
            { credentials: "include" },
          );
          results[section.key] = res.ok;
        } catch {
          results[section.key] = false;
        }
      }
      setFileExists(results);
    };

    checkFiles();
  }, [selectedProfile]);

  // Load file content when section or profile changes
  const loadFile = useCallback(async (profileId: string, filename: string) => {
    setLoadError(null);
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profileId)}/files/${encodeURIComponent(filename)}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        setContent(data.content);
        setDirty(false);
        setSaved(false);
        return true;
      }
      setContent("");
      setDirty(false);
      return false;
    } catch {
      setContent("");
      setDirty(false);
      setLoadError("Failed to load file");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!selectedProfile) return;
    const section = FILE_SECTIONS.find((s) => s.key === activeSection);
    if (!section) return;
    const filename = section.filename(selectedProfile);

    if (fileExists[activeSection]) {
      loadFile(selectedProfile.id, filename);
    } else {
      setContent("");
      setDirty(false);
      setLoadError(null);
    }
  }, [selectedProfile, activeSection, fileExists, loadFile]);

  // Reset to cfg section when profile changes
  useEffect(() => {
    setActiveSection("cfg");
  }, [selectedProfileId]);

  const saveFile = async () => {
    if (!selectedProfile) return;
    const section = FILE_SECTIONS.find((s) => s.key === activeSection);
    if (!section) return;
    const filename = section.filename(selectedProfile);

    setSaving(true);
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(filename)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content }),
        },
      );
      if (res.ok) {
        setSaved(true);
        setDirty(false);
        setFileExists((prev) => ({ ...prev, [activeSection]: true }));
        onRefreshProfiles();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // ignore
    }
    setSaving(false);
  };

  const createFile = async (sectionKey: string) => {
    if (!selectedProfile) return;
    const section = FILE_SECTIONS.find((s) => s.key === sectionKey);
    if (!section) return;
    const filename = section.filename(selectedProfile);
    const defaultContent = DEFAULT_CONTENT[filename] ?? "";

    try {
      await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(filename)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content: defaultContent }),
        },
      );
      setFileExists((prev) => ({ ...prev, [sectionKey]: true }));
      setActiveSection(sectionKey);
      setContent(defaultContent);
      setDirty(false);
    } catch {
      // ignore
    }
  };

  const deleteFile = async (sectionKey: string) => {
    if (!selectedProfile) return;
    const section = FILE_SECTIONS.find((s) => s.key === sectionKey);
    if (!section || !section.canCreate) return; // Don't delete the main cfg
    const filename = section.filename(selectedProfile);

    try {
      await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(filename)}`,
        { method: "DELETE", credentials: "include" },
      );
      setFileExists((prev) => ({ ...prev, [sectionKey]: false }));
      if (activeSection === sectionKey) {
        setContent("");
        setDirty(false);
      }
    } catch {
      // ignore
    }
  };

  // Fetch game files for import
  const fetchGameFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/game-files", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setGameFiles(data.files ?? []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (showImport) fetchGameFiles();
  }, [showImport, fetchGameFiles]);

  // Config files in gamePath that aren't already tied to a profile
  const profileConfigFiles = new Set(profiles.map((p) => p.configFile));
  const unlinkedCfgFiles = gameFiles.filter(
    (f) => f.toLowerCase().endsWith(".cfg") && !profileConfigFiles.has(f),
  );

  const importAsProfile = async (filename: string) => {
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: filename.replace(/\.cfg$/i, ""),
          existingConfigFile: filename,
        }),
      });
      if (res.ok) {
        const profile = await res.json();
        await onRefreshProfiles();
        setSelectedProfileId(profile.id);
        setShowImport(false);
      }
    } catch {
      // ignore
    }
  };

  const currentSection = FILE_SECTIONS.find((s) => s.key === activeSection);
  const currentFilename = selectedProfile && currentSection
    ? currentSection.filename(selectedProfile)
    : null;
  const currentFileExists = fileExists[activeSection] ?? false;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-zinc-300">
            D3 Server Configuration
          </h2>
          <p className="text-xs text-zinc-600">
            Edit Descent 3 dedicated server config files
          </p>
        </div>
        <div className="bg-amber-900/20 border border-amber-700/30 rounded-md px-2 py-1">
          <p className="text-xs text-amber-400">
            Changes take effect after server restart
          </p>
        </div>
      </div>

      {/* Profile selector + import */}
      <div className="flex items-center gap-2 mb-3 shrink-0">
        <label className="text-xs text-zinc-500 shrink-0">Profile:</label>
        <select
          value={selectedProfileId}
          onChange={(e) => setSelectedProfileId(e.target.value)}
          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 min-w-0"
        >
          <option value="">Select profile...</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.configFile})
            </option>
          ))}
        </select>
        <button
          onClick={() => setShowImport(!showImport)}
          className="text-xs text-amber-500 hover:text-amber-400 shrink-0 transition-colors"
          title="Import existing config file as a profile"
        >
          {showImport ? "Cancel" : "Import Existing"}
        </button>
      </div>

      {/* Import existing configs panel */}
      {showImport && (
        <div className="mb-3 p-2 bg-zinc-800/50 border border-zinc-700 rounded shrink-0">
          <p className="text-xs text-zinc-400 mb-2">
            Config files in game directory not linked to a profile:
          </p>
          {unlinkedCfgFiles.length > 0 ? (
            <div className="space-y-1">
              {unlinkedCfgFiles.map((f) => (
                <div key={f} className="flex items-center justify-between">
                  <span className="text-xs text-zinc-300 font-mono">{f}</span>
                  <button
                    onClick={() => importAsProfile(f)}
                    className="text-xs text-amber-500 hover:text-amber-400"
                  >
                    Create Profile
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-zinc-600 italic">
              {gameFiles.length === 0
                ? "No config files found in game directory"
                : "All config files are already linked to profiles"}
            </p>
          )}
        </div>
      )}

      {selectedProfile ? (
        <div className="flex-1 flex flex-col min-h-0">
          {/* File type tabs */}
          <div className="flex border-b border-zinc-800 mb-3 shrink-0">
            {FILE_SECTIONS.map((section) => {
              const exists = fileExists[section.key] ?? false;
              const isActive = activeSection === section.key;

              return (
                <button
                  key={section.key}
                  onClick={() => setActiveSection(section.key)}
                  className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                    isActive
                      ? "border-amber-500 text-amber-400"
                      : "border-transparent text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {section.label}
                  {!exists && section.canCreate && (
                    <span className="text-[10px] text-zinc-600">(none)</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Section header + actions */}
          <div className="flex items-start justify-between mb-2 shrink-0">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-zinc-300">
                  {currentSection?.label}
                </h3>
                {currentFilename && (
                  <span className="text-xs text-zinc-600 font-mono">
                    {currentFilename}
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                {currentSection?.description}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {currentFileExists && currentSection?.canCreate && (
                <button
                  onClick={() => deleteFile(activeSection)}
                  className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
              )}
              {currentFileExists && (
                <button
                  onClick={saveFile}
                  disabled={!dirty || saving}
                  className="px-3 py-1 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium rounded transition-colors"
                >
                  {saving ? "Saving..." : saved ? "Saved!" : "Save"}
                </button>
              )}
            </div>
          </div>

          {/* Editor area */}
          <div className="flex-1 min-h-0">
            {currentFileExists ? (
              <>
                {loadError ? (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-sm text-red-400">{loadError}</p>
                  </div>
                ) : (
                  <textarea
                    value={content}
                    onChange={(e) => {
                      setContent(e.target.value);
                      setDirty(true);
                      setSaved(false);
                    }}
                    className="h-full w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg font-mono text-sm text-zinc-200 resize-none focus:outline-none focus:ring-1 focus:ring-amber-500"
                    spellCheck={false}
                  />
                )}
              </>
            ) : currentSection?.canCreate ? (
              <div className="h-full flex flex-col items-center justify-center gap-2">
                <p className="text-sm text-zinc-600">
                  No {currentSection.label.toLowerCase()} file exists for this profile.
                </p>
                <button
                  onClick={() => createFile(activeSection)}
                  className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors"
                >
                  Create {currentFilename}
                </button>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm text-zinc-600">File not found</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-zinc-600">
            {profiles.length === 0
              ? "No server profiles. Create one in the Launch panel to get started."
              : "Select a profile to edit its configuration"}
          </p>
        </div>
      )}
    </div>
  );
}
