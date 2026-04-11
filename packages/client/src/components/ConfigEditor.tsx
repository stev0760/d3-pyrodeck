import { useState, useEffect, useCallback } from "react";
import type { ServerProfile } from "../hooks/useLauncher.ts";
import { ServerConfigForm } from "./ServerConfigForm.tsx";

interface ConfigEditorProps {
  profiles: ServerProfile[];
  onRefreshProfiles: () => void;
}

// --- Types matching backend ClassifiedGameFile ---

type GameFileType =
  | "server-config"
  | "bot-roster"
  | "ship-settings"
  | "startup-commands"
  | "unknown";

interface ClassifiedGameFile {
  filename: string;
  type: GameFileType;
  meta: Record<string, string>;
  linkedProfileId: string | null;
}

// --- File type display info ---

const FILE_TYPE_INFO: Record<
  GameFileType,
  { label: string; pluralLabel: string; color: string }
> = {
  "server-config": {
    label: "Server Config",
    pluralLabel: "Server Configs",
    color: "text-primary",
  },
  "bot-roster": {
    label: "Bot Roster",
    pluralLabel: "Bot Rosters",
    color: "text-sky-400",
  },
  "ship-settings": {
    label: "Ship Settings",
    pluralLabel: "Ship Settings",
    color: "text-violet-400",
  },
  "startup-commands": {
    label: "Startup Commands",
    pluralLabel: "Startup Commands",
    color: "text-emerald-400",
  },
  unknown: {
    label: "Other",
    pluralLabel: "Other Files",
    color: "text-foreground/60",
  },
};

const DIFFICULTY_NAMES: Record<string, string> = {
  "0": "Trainee",
  "1": "Rookie",
  "2": "Hotshot",
  "3": "Ace",
  "4": "Insane",
};

// --- Companion file info from backend ---

interface CompanionRef {
  filename: string;
  exists: boolean;
}

interface CompanionInfo {
  botConfig: CompanionRef | null;
  multiSettingsFile: CompanionRef | null;
  autoexec: CompanionRef;
}

// ============================================================
// Main ConfigEditor
// ============================================================

type ConfigView = "profiles" | "game-files";

export function ConfigEditor({
  profiles,
  onRefreshProfiles,
}: ConfigEditorProps) {
  const [view, setView] = useState<ConfigView>("profiles");

  return (
    <div className="h-full flex flex-col">
      {/* Header with view toggle */}
      <div className="flex items-center justify-between mb-3 shrink-0">
        <div className="flex items-center gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground/80">
              D3 Server Configuration
            </h2>
            <p className="text-xs text-muted-foreground">
              Manage server profiles and config files
            </p>
          </div>
          {/* View toggle */}
          <div className="flex bg-muted rounded p-0.5">
            <button
              onClick={() => setView("profiles")}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                view === "profiles"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground/80"
              }`}
            >
              Profiles
            </button>
            <button
              onClick={() => setView("game-files")}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                view === "game-files"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground/80"
              }`}
            >
              Game Files
            </button>
          </div>
        </div>
        <div className="bg-primary/10 border border-primary/20 rounded-md px-2 py-1">
          <p className="text-xs text-primary">
            Changes take effect after server restart
          </p>
        </div>
      </div>

      {/* View content */}
      <div className="flex-1 min-h-0">
        {view === "profiles" ? (
          <ProfileEditor
            profiles={profiles}
            onRefreshProfiles={onRefreshProfiles}
          />
        ) : (
          <GameFileBrowser
            profiles={profiles}
            onRefreshProfiles={onRefreshProfiles}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
// Profile Editor (entity management)
// ============================================================

function ProfileEditor({
  profiles,
  onRefreshProfiles,
}: {
  profiles: ServerProfile[];
  onRefreshProfiles: () => void;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [configViewMode, setConfigViewMode] = useState<"structured" | "raw">("structured");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [companions, setCompanions] = useState<CompanionInfo | null>(null);
  // For creating new bot roster with custom name
  const [showBotCreate, setShowBotCreate] = useState(false);
  const [newBotFilename, setNewBotFilename] = useState("bots.cfg");
  // For linking existing bot roster
  const [showBotLink, setShowBotLink] = useState(false);
  const [availableBotFiles, setAvailableBotFiles] = useState<ClassifiedGameFile[]>([]);

  // Auto-select first profile
  useEffect(() => {
    if (profiles.length > 0 && !selectedProfileId) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  // Fetch companion references from the server config
  const fetchCompanions = useCallback(async (profileId: string) => {
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(profileId)}/companions`,
        { credentials: "include" },
      );
      if (res.ok) {
        setCompanions(await res.json());
      }
    } catch {
      setCompanions(null);
    }
  }, []);

  useEffect(() => {
    if (selectedProfile) {
      fetchCompanions(selectedProfile.id);
    } else {
      setCompanions(null);
    }
    setShowBotCreate(false);
    setShowBotLink(false);
  }, [selectedProfileId, selectedProfile, fetchCompanions]);

  // Load the profile's main config on select
  useEffect(() => {
    if (selectedProfile) {
      setEditingFile(selectedProfile.configFile);
    } else {
      setEditingFile(null);
      setContent("");
    }
  }, [selectedProfileId, selectedProfile]);

  // Load file content when editingFile changes
  const loadFile = useCallback(async (filename: string) => {
    try {
      const res = await fetch(
        `/api/game-files/${encodeURIComponent(filename)}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        setContent(data.content);
        setDirty(false);
        setSaved(false);
      } else {
        setContent("");
        setDirty(false);
      }
    } catch {
      setContent("");
      setDirty(false);
    }
  }, []);

  useEffect(() => {
    if (editingFile) loadFile(editingFile);
  }, [editingFile, loadFile]);

  const saveFile = async () => {
    if (!selectedProfile || !editingFile) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(editingFile)}`,
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
        // Refresh companions in case server config references changed
        fetchCompanions(selectedProfile.id);
        onRefreshProfiles();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // ignore
    }
    setSaving(false);
  };

  // Create a new companion file with CVar reference
  const createCompanionFile = async (
    filename: string,
    defaultContent: string,
    cvar: string,
  ) => {
    if (!selectedProfile) return;
    try {
      await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(filename)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content: defaultContent, cvar }),
        },
      );
      await fetchCompanions(selectedProfile.id);
      setEditingFile(filename);
    } catch {
      // ignore
    }
  };

  // Link an existing file as a companion (just add the CVar reference, file already exists)
  const linkCompanionFile = async (filename: string, cvar: string) => {
    if (!selectedProfile) return;
    try {
      const manager = `/api/profiles/${encodeURIComponent(selectedProfile.id)}`;
      // Read existing content
      const readRes = await fetch(
        `/api/game-files/${encodeURIComponent(filename)}`,
        { credentials: "include" },
      );
      if (!readRes.ok) return;
      const { content: existingContent } = await readRes.json();

      // Write it back with the cvar reference
      await fetch(`${manager}/files/${encodeURIComponent(filename)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: existingContent, cvar }),
      });
      await fetchCompanions(selectedProfile.id);
      setEditingFile(filename);
      setShowBotLink(false);
    } catch {
      // ignore
    }
  };

  // Unlink a companion (remove CVar reference, don't delete the file)
  const unlinkCompanion = async (cvar: string) => {
    if (!selectedProfile) return;
    try {
      // Read the server config, remove the CVar line, write it back
      const res = await fetch(
        `/api/game-files/${encodeURIComponent(selectedProfile.configFile)}`,
        { credentials: "include" },
      );
      if (!res.ok) return;
      const { content: cfgContent } = await res.json();
      const lines = cfgContent.split("\n");
      const filtered = lines.filter(
        (l: string) => !l.trim().toLowerCase().startsWith(cvar.toLowerCase() + "="),
      );
      await fetch(
        `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/${encodeURIComponent(selectedProfile.configFile)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content: filtered.join("\n") }),
        },
      );
      await fetchCompanions(selectedProfile.id);
      setEditingFile(selectedProfile.configFile);
    } catch {
      // ignore
    }
  };

  // Fetch available bot roster files for linking
  const fetchBotFiles = useCallback(async () => {
    try {
      const res = await fetch("/api/game-files", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setAvailableBotFiles(
          (data.files as ClassifiedGameFile[]).filter(
            (f) => f.type === "bot-roster",
          ),
        );
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (showBotLink) fetchBotFiles();
  }, [showBotLink, fetchBotFiles]);

  if (profiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">
          No server profiles. Create one in the Launch panel to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex gap-3">
      {/* Left nav: profile selector + file navigation */}
      <div className="w-60 shrink-0 flex flex-col overflow-y-auto">
        {/* Profile selector */}
        <label className="text-xs text-muted-foreground mb-1">Profile</label>
        <select
          value={selectedProfileId}
          onChange={(e) => setSelectedProfileId(e.target.value)}
          className="px-2 py-1.5 bg-muted border border-border rounded text-sm text-foreground mb-3"
        >
          <option value="">Select profile...</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {selectedProfile && companions && (
          <>
            {/* Server config (primary) */}
            <NavButton
              label="Server Config"
              filename={selectedProfile.configFile}
              isActive={editingFile === selectedProfile.configFile}
              onClick={() => setEditingFile(selectedProfile.configFile)}
            />

            {/* Companion files section */}
            <div className="mt-3 mb-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Companion Files
              </span>
            </div>

            {/* Ship Settings (MultiSettingsFile) */}
            {companions.multiSettingsFile ? (
              <CompanionEntry
                label="Ship Settings"
                filename={companions.multiSettingsFile.filename}
                exists={companions.multiSettingsFile.exists}
                isActive={editingFile === companions.multiSettingsFile.filename}
                onEdit={() =>
                  setEditingFile(companions.multiSettingsFile!.filename)
                }
                onUnlink={() => unlinkCompanion("MultiSettingsFile")}
              />
            ) : (
              <CompanionCreateButton
                label="Ship Settings"
                description="Ship allow/ban rules (MultiSettingsFile)"
                onClick={() =>
                  createCompanionFile(
                    "companion.mps",
                    "[multi settings file]\n",
                    "MultiSettingsFile",
                  )
                }
              />
            )}

            {/* Bot Roster (BotConfig) */}
            {companions.botConfig ? (
              <CompanionEntry
                label="Bot Roster"
                filename={companions.botConfig.filename}
                exists={companions.botConfig.exists}
                isActive={editingFile === companions.botConfig.filename}
                onEdit={() => setEditingFile(companions.botConfig!.filename)}
                onUnlink={() => unlinkCompanion("BotConfig")}
              />
            ) : (
              <div className="mb-0.5">
                {showBotCreate ? (
                  <div className="px-2 py-1.5 bg-muted/50 rounded text-xs space-y-1.5">
                    <div className="font-medium text-foreground/60">
                      New Bot Roster
                    </div>
                    <input
                      type="text"
                      value={newBotFilename}
                      onChange={(e) => setNewBotFilename(e.target.value)}
                      placeholder="bots.cfg"
                      className="w-full bg-background border border-border rounded px-2 py-1 text-xs text-foreground/90 font-mono focus:outline-none focus:border-ring"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newBotFilename.trim()) {
                          createCompanionFile(
                            newBotFilename.trim(),
                            "BotCount=0\nBotDifficulty=2\n",
                            "BotConfig",
                          );
                          setShowBotCreate(false);
                          setNewBotFilename("bots.cfg");
                        }
                      }}
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={() => {
                          if (newBotFilename.trim()) {
                            createCompanionFile(
                              newBotFilename.trim(),
                              "BotCount=0\nBotDifficulty=2\n",
                              "BotConfig",
                            );
                            setShowBotCreate(false);
                            setNewBotFilename("bots.cfg");
                          }
                        }}
                        disabled={!newBotFilename.trim()}
                        className="text-[10px] text-primary hover:text-primary disabled:text-muted-foreground"
                      >
                        Create
                      </button>
                      <button
                        onClick={() => setShowBotCreate(false)}
                        className="text-[10px] text-muted-foreground hover:text-foreground/60"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : showBotLink ? (
                  <div className="px-2 py-1.5 bg-muted/50 rounded text-xs space-y-1">
                    <div className="font-medium text-foreground/60">
                      Link Existing Bot Roster
                    </div>
                    {availableBotFiles.length > 0 ? (
                      <div className="space-y-0.5">
                        {availableBotFiles.map((f) => (
                          <button
                            key={f.filename}
                            onClick={() =>
                              linkCompanionFile(f.filename, "BotConfig")
                            }
                            className="w-full text-left px-1.5 py-1 rounded text-[11px] font-mono text-foreground/80 hover:bg-accent transition-colors"
                          >
                            {f.filename}
                            {f.meta.botCount && (
                              <span className="text-muted-foreground ml-1">
                                ({f.meta.botCount} bots)
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground italic">
                        No bot roster files found
                      </p>
                    )}
                    <button
                      onClick={() => setShowBotLink(false)}
                      className="text-[10px] text-muted-foreground hover:text-foreground/60"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => setShowBotCreate(true)}
                      className="w-full text-left px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground/60 hover:bg-muted/50 transition-colors"
                    >
                      <span className="font-medium">Bot Roster</span>
                      <span className="text-muted-foreground/60 ml-1">(create new)</span>
                    </button>
                    <button
                      onClick={() => setShowBotLink(true)}
                      className="w-full text-left px-2 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground/60 hover:bg-muted/50 transition-colors"
                    >
                      Link existing roster...
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Startup Commands (autoexec.dmfc) */}
            {companions.autoexec.exists ? (
              <CompanionEntry
                label="Startup Commands"
                filename="autoexec.dmfc"
                exists={true}
                isActive={editingFile === "autoexec.dmfc"}
                onEdit={() => setEditingFile("autoexec.dmfc")}
                onUnlink={async () => {
                  if (!selectedProfile) return;
                  try {
                    await fetch(
                      `/api/profiles/${encodeURIComponent(selectedProfile.id)}/files/autoexec.dmfc`,
                      { method: "DELETE", credentials: "include" },
                    );
                    await fetchCompanions(selectedProfile.id);
                    setEditingFile(selectedProfile.configFile);
                  } catch {
                    // ignore
                  }
                }}
                unlinkLabel="Delete"
              />
            ) : (
              <CompanionCreateButton
                label="Startup Commands"
                description="Post-init DMFC commands"
                onClick={() =>
                  createCompanionFile("autoexec.dmfc", "", "")
                }
              />
            )}
          </>
        )}
      </div>

      {/* Right: editor area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {editingFile ? (
          <>
            {/* Editor header */}
            <div className="flex items-center justify-between mb-2 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono">
                  {editingFile}
                </span>
                {/* Structured/Raw toggle — only for the main server config */}
                {selectedProfile && editingFile === selectedProfile.configFile && (
                  <div className="flex bg-muted rounded p-0.5">
                    <button
                      onClick={() => setConfigViewMode("structured")}
                      className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                        configViewMode === "structured"
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground/80"
                      }`}
                    >
                      Structured
                    </button>
                    <button
                      onClick={() => setConfigViewMode("raw")}
                      className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                        configViewMode === "raw"
                          ? "bg-secondary text-foreground"
                          : "text-muted-foreground hover:text-foreground/80"
                      }`}
                    >
                      Raw
                    </button>
                  </div>
                )}
              </div>
              {/* Save button — only shown in raw mode (structured form has its own) */}
              {(configViewMode === "raw" || editingFile !== selectedProfile?.configFile) && (
                <button
                  onClick={saveFile}
                  disabled={!dirty || saving}
                  className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors"
                >
                  {saving ? "Saving..." : saved ? "Saved!" : "Save"}
                </button>
              )}
            </div>

            {/* Structured form or raw textarea */}
            {selectedProfile &&
            editingFile === selectedProfile.configFile &&
            configViewMode === "structured" ? (
              <ServerConfigForm
                profileId={selectedProfile.id}
                onSaved={() => {
                  fetchCompanions(selectedProfile.id);
                  onRefreshProfiles();
                }}
              />
            ) : (
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                  setSaved(false);
                }}
                className="flex-1 w-full px-3 py-2 bg-background border border-border rounded-lg font-mono text-sm text-foreground/90 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                spellCheck={false}
              />
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a profile to edit its configuration
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Profile Editor sub-components
// ============================================================

function NavButton({
  label,
  filename,
  isActive,
  onClick,
}: {
  label: string;
  filename: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-2 py-1.5 rounded text-xs transition-colors ${
        isActive
          ? "bg-primary/15 text-primary border border-primary/30"
          : "text-foreground/80 hover:bg-muted"
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-muted-foreground font-mono text-[11px] mt-0.5">
        {filename}
      </div>
    </button>
  );
}

function CompanionEntry({
  label,
  filename,
  exists,
  isActive,
  onEdit,
  onUnlink,
  unlinkLabel = "Unlink",
}: {
  label: string;
  filename: string;
  exists: boolean;
  isActive: boolean;
  onEdit: () => void;
  onUnlink: () => void;
  unlinkLabel?: string;
}) {
  return (
    <div className="mb-0.5 flex items-center gap-1">
      <button
        onClick={onEdit}
        disabled={!exists}
        className={`flex-1 text-left px-2 py-1.5 rounded text-xs transition-colors ${
          isActive
            ? "bg-primary/15 text-primary border border-primary/30"
            : exists
              ? "text-foreground/80 hover:bg-muted"
              : "text-muted-foreground"
        }`}
      >
        <div className="font-medium">
          {label}
          {!exists && (
            <span className="text-destructive/60 ml-1 font-normal">(missing)</span>
          )}
        </div>
        <div className="text-muted-foreground font-mono text-[11px] mt-0.5">
          {filename}
        </div>
      </button>
      <button
        onClick={onUnlink}
        className="text-muted-foreground hover:text-destructive p-1 transition-colors"
        title={`${unlinkLabel} ${filename}`}
      >
        <svg
          className="w-3 h-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}

function CompanionCreateButton({
  label,
  description,
  onClick,
}: {
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground/60 hover:bg-muted/50 transition-colors mb-0.5"
    >
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground/60 ml-1">(create)</span>
      <div className="text-[11px] text-muted-foreground/60 mt-0.5">{description}</div>
    </button>
  );
}

// ============================================================
// Game File Browser (file-oriented discovery)
// ============================================================

function GameFileBrowser({
  profiles,
  onRefreshProfiles,
}: {
  profiles: ServerProfile[];
  onRefreshProfiles: () => void;
}) {
  const [gameFiles, setGameFiles] = useState<ClassifiedGameFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Fetch classified files
  const fetchFiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/game-files", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setGameFiles(data.files ?? []);
      }
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Load content when file selected
  useEffect(() => {
    if (!selectedFile) {
      setPreviewContent(null);
      setEditing(false);
      return;
    }
    setEditing(false);
    setDirty(false);
    setSaved(false);
    const loadContent = async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch(
          `/api/game-files/${encodeURIComponent(selectedFile)}`,
          { credentials: "include" },
        );
        if (res.ok) {
          const data = await res.json();
          setPreviewContent(data.content);
          setEditContent(data.content);
        } else {
          setPreviewContent(null);
          setEditContent("");
        }
      } catch {
        setPreviewContent(null);
        setEditContent("");
      }
      setPreviewLoading(false);
    };
    loadContent();
  }, [selectedFile]);

  const saveFile = async () => {
    if (!selectedFile) return;
    setSaving(true);
    try {
      const res = await fetch(
        `/api/game-files/${encodeURIComponent(selectedFile)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ content: editContent }),
        },
      );
      if (res.ok) {
        setPreviewContent(editContent);
        setDirty(false);
        setSaved(true);
        fetchFiles();
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {
      // ignore
    }
    setSaving(false);
  };

  // Group files by type
  const grouped = new Map<GameFileType, ClassifiedGameFile[]>();
  const typeOrder: GameFileType[] = [
    "server-config",
    "bot-roster",
    "ship-settings",
    "startup-commands",
    "unknown",
  ];
  for (const type of typeOrder) {
    grouped.set(type, []);
  }
  for (const file of gameFiles) {
    const list = grouped.get(file.type);
    if (list) list.push(file);
    else grouped.get("unknown")!.push(file);
  }

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
        await onRefreshProfiles();
        await fetchFiles();
      }
    } catch {
      // ignore
    }
  };

  const selectedFileInfo = gameFiles.find((f) => f.filename === selectedFile);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Scanning game directory...</p>
      </div>
    );
  }

  if (gameFiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-muted-foreground">
          No config files found in game directory
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex gap-3">
      {/* Left: categorized file list */}
      <div className="w-72 shrink-0 overflow-y-auto space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">Files in game directory</p>
          <button
            onClick={fetchFiles}
            className="text-xs text-muted-foreground hover:text-foreground/60 transition-colors"
          >
            Refresh
          </button>
        </div>

        {typeOrder.map((type) => {
          const files = grouped.get(type) ?? [];
          if (files.length === 0) return null;
          const info = FILE_TYPE_INFO[type];

          return (
            <div key={type}>
              {/* Section header */}
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider ${info.color}`}
                >
                  {info.pluralLabel}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  ({files.length})
                </span>
              </div>

              {/* File list */}
              <div className="space-y-0.5">
                {files.map((file) => (
                  <GameFileRow
                    key={file.filename}
                    file={file}
                    isSelected={selectedFile === file.filename}
                    profiles={profiles}
                    onSelect={() => setSelectedFile(file.filename)}
                    onImport={() => importAsProfile(file.filename)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right: preview pane */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background border border-border rounded-lg overflow-hidden">
        {selectedFile && selectedFileInfo ? (
          <>
            {/* Preview header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-foreground/80">
                  {selectedFile}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${FILE_TYPE_INFO[selectedFileInfo.type].color} bg-muted`}
                >
                  {FILE_TYPE_INFO[selectedFileInfo.type].label}
                </span>
                {selectedFileInfo.linkedProfileId && (
                  <span className="text-[10px] text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded">
                    Linked to profile
                  </span>
                )}
              </div>
              {/* Actions */}
              <div className="flex items-center gap-2">
                {selectedFileInfo.type === "server-config" &&
                  !selectedFileInfo.linkedProfileId && (
                    <button
                      onClick={() => importAsProfile(selectedFile)}
                      className="text-xs text-primary hover:text-primary transition-colors"
                    >
                      Import as Profile
                    </button>
                  )}
                {editing ? (
                  <>
                    <button
                      onClick={saveFile}
                      disabled={!dirty || saving}
                      className="px-3 py-1 bg-primary hover:bg-primary/80 disabled:bg-muted disabled:text-muted-foreground text-white text-xs font-medium rounded transition-colors"
                    >
                      {saving ? "Saving..." : saved ? "Saved!" : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setEditing(false);
                        setEditContent(previewContent ?? "");
                        setDirty(false);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground/80 transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setEditing(true)}
                    className="text-xs text-muted-foreground hover:text-foreground/80 transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            {/* Metadata bar */}
            {Object.keys(selectedFileInfo.meta).length > 0 && (
              <div className="px-3 py-1.5 border-b border-border/50 flex flex-wrap gap-3 shrink-0">
                {selectedFileInfo.type === "server-config" && (
                  <>
                    {selectedFileInfo.meta.gameName && (
                      <MetaChip
                        label="Name"
                        value={selectedFileInfo.meta.gameName}
                      />
                    )}
                    {selectedFileInfo.meta.scriptName && (
                      <MetaChip
                        label="Mode"
                        value={selectedFileInfo.meta.scriptName.replace(
                          /\.d3m$/,
                          "",
                        )}
                      />
                    )}
                    {selectedFileInfo.meta.maxPlayers && (
                      <MetaChip
                        label="Players"
                        value={selectedFileInfo.meta.maxPlayers}
                      />
                    )}
                    {selectedFileInfo.meta.missionName && (
                      <MetaChip
                        label="Mission"
                        value={selectedFileInfo.meta.missionName}
                      />
                    )}
                  </>
                )}
                {selectedFileInfo.type === "bot-roster" && (
                  <>
                    {selectedFileInfo.meta.botCount && (
                      <MetaChip
                        label="Bots"
                        value={selectedFileInfo.meta.botCount}
                      />
                    )}
                    {selectedFileInfo.meta.difficulty && (
                      <MetaChip
                        label="Difficulty"
                        value={
                          DIFFICULTY_NAMES[selectedFileInfo.meta.difficulty] ??
                          selectedFileInfo.meta.difficulty
                        }
                      />
                    )}
                  </>
                )}
                {selectedFileInfo.type === "startup-commands" &&
                  selectedFileInfo.meta.commands && (
                    <MetaChip
                      label="Commands"
                      value={selectedFileInfo.meta.commands}
                    />
                  )}
              </div>
            )}

            {/* Content area */}
            <div className="flex-1 min-h-0 overflow-auto">
              {previewLoading ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">Loading...</p>
                </div>
              ) : editing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value);
                    setDirty(true);
                    setSaved(false);
                  }}
                  className="w-full h-full px-3 py-2 bg-transparent font-mono text-xs text-foreground/90 resize-none focus:outline-none"
                  spellCheck={false}
                />
              ) : previewContent !== null ? (
                <pre className="px-3 py-2 text-xs font-mono text-foreground/60 whitespace-pre-wrap">
                  {previewContent}
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">Unable to read file</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a file to preview its contents
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Game File Browser sub-components
// ============================================================

function GameFileRow({
  file,
  isSelected,
  profiles,
  onSelect,
  onImport,
}: {
  file: ClassifiedGameFile;
  isSelected: boolean;
  profiles: ServerProfile[];
  onSelect: () => void;
  onImport: () => void;
}) {
  const linkedProfile = file.linkedProfileId
    ? profiles.find((p) => p.id === file.linkedProfileId)
    : null;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
        isSelected
          ? "bg-muted border border-border"
          : "hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-foreground/80 truncate">
          {file.filename}
        </span>
      </div>
      {/* Inline metadata */}
      <div className="flex items-center gap-2 mt-0.5">
        {file.type === "server-config" && file.meta.scriptName && (
          <span className="text-[10px] text-muted-foreground">
            {file.meta.scriptName.replace(/\.d3m$/, "")}
          </span>
        )}
        {file.type === "server-config" && file.meta.maxPlayers && (
          <span className="text-[10px] text-muted-foreground">
            {file.meta.maxPlayers}p
          </span>
        )}
        {file.type === "bot-roster" && file.meta.botCount && (
          <span className="text-[10px] text-muted-foreground">
            {file.meta.botCount} bots
          </span>
        )}
        {linkedProfile && (
          <span className="text-[10px] text-primary/60">
            {linkedProfile.name}
          </span>
        )}
        {file.type === "server-config" && !linkedProfile && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onImport();
            }}
            className="text-[10px] text-primary/70 hover:text-primary ml-auto transition-colors"
          >
            Import
          </button>
        )}
      </div>
    </button>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-[11px]">
      <span className="text-muted-foreground">{label}: </span>
      <span className="text-foreground/60">{value}</span>
    </span>
  );
}
