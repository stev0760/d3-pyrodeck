import { useState } from "react";
import { Button } from "@/components/ui/button";
import { sendJson, type LaunchScriptPreview } from "@/lib/ops";
import type { ServerProfile } from "../hooks/useLauncher.ts";

const INPUT_CLASS =
  "w-full bg-input border border-border rounded-md px-2 py-1 text-xs text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring";
const MAX_FILE_BYTES = 64 * 1024;

function Check({ ok, label, errors }: { ok: boolean; label: string; errors: string[] }) {
  return (
    <p className={`text-[11px] ${ok ? "text-emerald-500" : "text-amber-400"} break-words`}>
      {ok ? "✓" : "✗"} {label}
      {!ok && errors.length > 0 ? `: ${errors.join("; ")}` : ""}
    </p>
  );
}

/**
 * Import a profile from the batch file or shell script that launched a
 * server: paste or pick it, check the preview, create. The config file must
 * already be in the game directory; Pyrodeck links to it, it does not copy.
 */
export function LaunchScriptImport({
  createProfile,
  onCreated,
  onCancel,
}: {
  createProfile: (name: string, opts?: Record<string, unknown>) => Promise<ServerProfile | null>;
  onCreated: (profile: ServerProfile) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<LaunchScriptPreview | null>(null);
  const [name, setName] = useState("");
  const [gamePath, setGamePath] = useState("");
  const [executablePath, setExecutablePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is larger than 64 KB; it is not a launch script.");
      return;
    }
    setText(await file.text());
    setFileName(file.name);
    setPreview(null);
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    const res = await sendJson<LaunchScriptPreview>("POST", "/api/launch-script/preview", { text, fileName });
    setBusy(false);
    if (res.error !== null) {
      setError(res.error);
      return;
    }
    setPreview(res.data);
    setName(res.data.profile.name);
    setGamePath(res.data.profile.gamePath ?? "");
    setExecutablePath(res.data.profile.executablePath ?? "");
  };

  const create = async () => {
    if (!preview?.profile.configFile) return;
    setBusy(true);
    const profile = await createProfile(name.trim(), {
      existingConfigFile: preview.profile.configFile,
      gamePath: gamePath.trim() || undefined,
      executablePath: executablePath.trim() || undefined,
      launchOptions: preview.profile.launchOptions ?? undefined,
      importedArgs: preview.profile.importedArgs,
    });
    setBusy(false);
    if (profile) onCreated(profile);
  };

  const s = preview?.script;
  const p = preview?.profile;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-score tracking-wide text-muted-foreground">Import Launch Script</h3>
      <p className="text-[10px] text-muted-foreground leading-snug">
        Paste the .bat, .cmd or .sh that starts your server (the line with <span className="font-mono">-dedicated</span>),
        or pick the file. Pyrodeck reads it here; nothing runs.
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        rows={5}
        placeholder={'start "" "C:\\Games\\Descent3\\main.exe" -dedicated server.cfg -useport 2092'}
        className={`${INPUT_CLASS} resize-y`}
        spellCheck={false}
      />
      <div className="flex items-center gap-1.5">
        <label className="text-[11px] text-primary hover:underline cursor-pointer">
          Pick a file…
          <input
            type="file"
            accept=".bat,.cmd,.sh,text/plain"
            className="hidden"
            onChange={(e) => void pickFile(e.target.files?.[0])}
          />
        </label>
        {fileName && <span className="text-[10px] text-muted-foreground truncate">{fileName}</span>}
      </div>
      <div className="flex gap-1.5">
        <Button size="xs" onClick={() => void runPreview()} disabled={busy || !text.trim()} className="flex-1 font-score tracking-wide">
          {busy && !preview ? "Reading..." : "Preview"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel} className="flex-1 font-score tracking-wide">
          Cancel
        </Button>
      </div>
      {error && <p className="text-[11px] text-destructive break-words">{error}</p>}

      {s && p && (
        <div className="space-y-1.5 border-t border-border pt-2">
          {s.commandLine ? (
            <p className="text-[10px] font-mono text-foreground/80 break-all bg-muted rounded-md px-2 py-1">{s.commandLine}</p>
          ) : null}
          <label className="block text-[10px] text-muted-foreground">
            Profile name
            <input value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT_CLASS} mt-0.5`} />
          </label>
          <label className="block text-[10px] text-muted-foreground">
            Game Path
            <input value={gamePath} onChange={(e) => setGamePath(e.target.value)} className={`${INPUT_CLASS} mt-0.5`} />
          </label>
          <label className="block text-[10px] text-muted-foreground">
            Executable
            <input
              value={executablePath}
              onChange={(e) => setExecutablePath(e.target.value)}
              className={`${INPUT_CLASS} mt-0.5`}
            />
          </label>
          <p className="text-[10px] text-muted-foreground">
            Server config: <span className="font-mono text-foreground/80">{p.configFile ?? "none"}</span>
          </p>
          <div>
            <Check ok={preview.checks.gamePath.valid} label="Game Path found" errors={preview.checks.gamePath.errors} />
            <Check ok={preview.checks.executable.valid} label="Executable found" errors={preview.checks.executable.errors} />
            <Check ok={preview.checks.configFile.valid} label="Config in the Game Path" errors={preview.checks.configFile.errors} />
          </div>
          {p.launchOptionArgs.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              Launch Options (applied at every launch):
              <p className="font-mono text-foreground/80 break-all">{p.launchOptionArgs.join(" ")}</p>
            </div>
          )}
          {p.importedArgs.length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              Kept as imported flags (not applied by Pyrodeck):
              <p className="font-mono text-foreground/80 break-all">{p.importedArgs.join(" ")}</p>
            </div>
          )}
          {[...p.notes, ...s.warnings].map((n) => (
            <p key={n} className="text-[10px] text-amber-400 leading-snug break-words">
              {n}
            </p>
          ))}
          <p className="text-[10px] text-muted-foreground leading-snug">
            Paths are checked on the Pyrodeck machine. If the script came from another machine, fix the Game Path and
            Executable above, and copy the config into the Game Path first.
          </p>
          <Button
            size="xs"
            onClick={() => void create()}
            disabled={busy || !name.trim() || !p.configFile}
            className="w-full font-score tracking-wide"
          >
            {busy ? "Creating..." : "Create Profile"}
          </Button>
        </div>
      )}
    </div>
  );
}
