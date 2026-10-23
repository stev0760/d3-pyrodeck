import { useState, useEffect, useCallback } from "react";

/** A file the server config names (BotConfig=, MultiSettingsFile=) or the autoexec. */
export interface CompanionRef {
  filename: string;
  exists: boolean;
}

export interface CompanionInfo {
  botConfig: CompanionRef | null;
  multiSettingsFile: CompanionRef | null;
  autoexec: CompanionRef;
}

export type GameFileType = "server-config" | "bot-roster" | "ship-settings" | "startup-commands" | "unknown";

export interface ClassifiedGameFile {
  filename: string;
  type: GameFileType;
  meta: Record<string, string>;
  linkedProfileId: string | null;
}

async function errorOf(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${fallback} (HTTP ${res.status})`;
}

/**
 * The companion files of a profile's server config and the ways to attach
 * one: create it, link an existing file (the config gets the `Key=` line),
 * unlink it (the line goes, the file stays) or delete it (the autoexec).
 */
export function useCompanions(profileId: string | undefined, configFile: string | undefined) {
  const [companions, setCompanions] = useState<CompanionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = profileId ? `/api/profiles/${encodeURIComponent(profileId)}` : null;

  const refresh = useCallback(async () => {
    if (!api) {
      setCompanions(null);
      return;
    }
    try {
      const res = await fetch(`${api}/companions`, { credentials: "include" });
      if (res.ok) {
        setCompanions((await res.json()) as CompanionInfo);
        setError(null);
      } else {
        setError(await errorOf(res, "Could not read the companion files"));
      }
    } catch {
      setError("Could not read the companion files: network error");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const writeFile = useCallback(
    async (filename: string, content: string, cvar?: string): Promise<boolean> => {
      if (!api) return false;
      try {
        const res = await fetch(`${api}/files/${encodeURIComponent(filename)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(cvar ? { content, cvar } : { content }),
        });
        if (!res.ok) {
          setError(await errorOf(res, `Could not write ${filename}`));
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError(`Could not write ${filename}: network error`);
        return false;
      }
    },
    [api, refresh],
  );

  /** Create a companion with the given content and point the config at it. */
  const createCompanionFile = useCallback(
    (filename: string, content: string, cvar: string) => writeFile(filename, content, cvar),
    [writeFile],
  );

  /** Point the config at a file that already exists. */
  const linkCompanionFile = useCallback(
    async (filename: string, cvar: string): Promise<boolean> => {
      if (!api) return false;
      try {
        const res = await fetch(`${api}/files/${encodeURIComponent(filename)}`, { credentials: "include" });
        if (!res.ok) {
          setError(await errorOf(res, `Could not read ${filename}`));
          return false;
        }
        const { content } = (await res.json()) as { content: string };
        return await writeFile(filename, content, cvar);
      } catch {
        setError(`Could not link ${filename}: network error`);
        return false;
      }
    },
    [api, writeFile],
  );

  /** Remove the `Key=` line from the server config; the file stays. */
  const unlinkCompanion = useCallback(
    async (cvar: string): Promise<boolean> => {
      if (!api || !configFile) return false;
      try {
        const res = await fetch(`${api}/files/${encodeURIComponent(configFile)}`, { credentials: "include" });
        if (!res.ok) {
          setError(await errorOf(res, "Could not read the server config"));
          return false;
        }
        const { content } = (await res.json()) as { content: string };
        const filtered = content
          .split("\n")
          .filter((l: string) => !l.trim().toLowerCase().startsWith(cvar.toLowerCase() + "="))
          .join("\n");
        return await writeFile(configFile, filtered);
      } catch {
        setError("Could not update the server config: network error");
        return false;
      }
    },
    [api, configFile, writeFile],
  );

  const deleteFile = useCallback(
    async (filename: string): Promise<boolean> => {
      if (!api) return false;
      try {
        const res = await fetch(`${api}/files/${encodeURIComponent(filename)}`, { method: "DELETE", credentials: "include" });
        if (!res.ok) {
          setError(await errorOf(res, `Could not delete ${filename}`));
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError(`Could not delete ${filename}: network error`);
        return false;
      }
    },
    [api, refresh],
  );

  /** A new roster from the Matcen sample, named by the operator, linked as BotConfig=. */
  const createRosterFromSample = useCallback(
    async (filename: string): Promise<boolean> => {
      if (!api) return false;
      try {
        const res = await fetch(`${api}/bot-roster/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ filename }),
        });
        if (!res.ok) {
          setError(await errorOf(res, "Could not create the roster"));
          return false;
        }
        await refresh();
        return true;
      } catch {
        setError("Could not create the roster: network error");
        return false;
      }
    },
    [api, refresh],
  );

  /** The classified files in the profile's game directory. */
  const listGameFiles = useCallback(async (): Promise<ClassifiedGameFile[]> => {
    if (!profileId) return [];
    try {
      const res = await fetch(`/api/game-files?profileId=${encodeURIComponent(profileId)}`, { credentials: "include" });
      if (!res.ok) return [];
      const data = (await res.json()) as { files: ClassifiedGameFile[] };
      return data.files;
    } catch {
      return [];
    }
  }, [profileId]);

  return {
    companions,
    error,
    clearError: () => setError(null),
    refresh,
    createCompanionFile,
    linkCompanionFile,
    unlinkCompanion,
    deleteFile,
    createRosterFromSample,
    listGameFiles,
  };
}
