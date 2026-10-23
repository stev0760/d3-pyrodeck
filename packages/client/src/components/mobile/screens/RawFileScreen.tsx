import { useState } from "react";
import type { HashRouter } from "@/hooks/useHashRoute";
import { useProfileFile } from "@/hooks/useProfileFile";
import { Screen } from "../Screen.tsx";
import { BigButton } from "@/components/compact/BigButton";
import { ConfirmDialog } from "@/components/compact/ConfirmDialog";
import { EmptyState } from "@/components/compact/EmptyState";

interface RawFileScreenProps {
  router: HashRouter;
  profileId: string | undefined;
  filename: string | undefined;
  /** A line under the header, e.g. what the file is for. */
  hint?: string;
  /** After a successful save or restore. */
  onSaved?: () => void;
}

/** A text file as it is on disk, with Save and the previous version. */
export function RawFileScreen({ router, profileId, filename, hint, onSaved }: RawFileScreenProps) {
  const file = useProfileFile(profileId, filename);
  const [confirmRestore, setConfirmRestore] = useState(false);

  if (!filename || !profileId) {
    return (
      <Screen title="File" onBack={router.back}>
        <EmptyState title="No file chosen" />
      </Screen>
    );
  }

  return (
    <Screen title={filename} onBack={router.back} scroll={false}>
      {hint && <p className="px-4 pt-3 text-sm text-muted-foreground leading-snug shrink-0">{hint}</p>}
      {file.error && (
        <p className="mx-4 mt-3 text-sm text-destructive bg-destructive/10 border border-destructive/40 rounded-lg px-3 py-2 break-words shrink-0">
          {file.error}
        </p>
      )}
      <div className="flex-1 min-h-0 p-3">
        <textarea
          value={file.content}
          onChange={(e) => file.setContent(e.target.value)}
          disabled={file.loading}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`${filename} content`}
          className="h-full w-full resize-none px-3 py-2 rounded-xl bg-background border border-border font-mono text-base text-foreground/90 leading-snug focus:outline-none focus:ring-2 focus:ring-ring/60"
        />
      </div>
      <div className="shrink-0 px-3 pb-3 flex flex-col gap-2">
        <BigButton
          onClick={async () => {
            if (await file.save()) onSaved?.();
          }}
          disabled={!file.dirty || file.busy || file.loading}
        >
          {file.busy ? "Saving…" : file.dirty ? "Save" : "Saved"}
        </BigButton>
        {file.backup?.exists && (
          <button
            type="button"
            onClick={() => setConfirmRestore(true)}
            disabled={file.busy}
            className="h-10 text-sm text-muted-foreground active:text-foreground"
          >
            Restore previous version
            {file.backup.mtime ? ` (${new Date(file.backup.mtime).toLocaleString()})` : ""}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmRestore}
        onOpenChange={setConfirmRestore}
        title="Restore the previous version?"
        description={`${filename} goes back to the version saved before the last change. The current content becomes the previous version, so this can be undone the same way.`}
        confirmLabel="Restore"
        busy={file.busy}
        onConfirm={async () => {
          if (await file.restore()) onSaved?.();
          setConfirmRestore(false);
        }}
      />
    </Screen>
  );
}
