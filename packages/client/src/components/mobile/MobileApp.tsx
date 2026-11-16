import { useEffect, useState } from "react";
import { useSession } from "@/session/SessionProvider";
import { replaceHash, useHashRoute } from "@/hooks/useHashRoute";
import { serverOfRoute, withServer } from "@/lib/hashRoute";
import { ServerPickerContext, ServerPickerSheet } from "./ServerPicker.tsx";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { UpdateBanner } from "../UpdateBanner.tsx";
import { ToastContainer } from "../ToastContainer.tsx";
import { TabBar } from "./TabBar.tsx";
import { ServerScreen } from "./screens/ServerScreen.tsx";
import { ConsoleScreen } from "./screens/ConsoleScreen.tsx";
import { PlayersScreen } from "./screens/PlayersScreen.tsx";
import { BotsScreen } from "./screens/BotsScreen.tsx";
import { MoreScreen } from "./screens/MoreScreen.tsx";

export interface ShellProps {
  onLogout: () => void;
  showLogout: boolean;
}

/**
 * The phone layout: one screen at a time, picked by the URL hash, a tab bar
 * along the bottom. Everything stateful comes from the session, which the
 * desktop layout shares, so switching layouts loses nothing.
 */
export function MobileApp({ onLogout, showLogout }: ShellProps) {
  const session = useSession();
  const router = useHashRoute();
  const keyboard = useKeyboardInset();

  const [pickerOpen, setPickerOpen] = useState(false);

  // The server on screen rides in the hash (`?s=`), so a reload or a shared
  // link opens it. The selection is the truth: a history entry that names
  // another server is rewritten, never followed into a silent switch.
  const { selectedServerId } = session;
  const hashServer = serverOfRoute(router.route);
  useEffect(() => {
    if (selectedServerId && hashServer !== selectedServerId) {
      replaceHash(withServer(window.location.hash, selectedServerId));
    }
  }, [selectedServerId, hashServer]);

  // Lets global styles (the sheet scrim, say) know a phone shell is up; the
  // sheets render outside this tree.
  useEffect(() => {
    document.body.dataset.shell = "phone";
    return () => {
      delete document.body.dataset.shell;
    };
  }, []);

  let screen;
  switch (router.tab) {
    case "console":
      screen = <ConsoleScreen router={router} />;
      break;
    case "players":
      screen = <PlayersScreen router={router} />;
      break;
    case "bots":
      screen = <BotsScreen router={router} />;
      break;
    case "more":
      screen = <MoreScreen router={router} onLogout={onLogout} showLogout={showLogout} />;
      break;
    default:
      screen = <ServerScreen router={router} />;
  }

  const botsEnabled = session.isConnected && session.connection.hasFeature("bots");

  return (
    <ServerPickerContext.Provider value={() => setPickerOpen(true)}>
    <div className="pd-mobile h-dvh flex flex-col bg-background text-foreground" style={keyboard ? { paddingBottom: keyboard } : undefined}>
      <UpdateBanner />
      {session.connection.wsReconnecting && (
        <div className="px-4 py-2 bg-primary/10 border-b border-primary/30 text-primary text-sm text-center shrink-0">
          Connection lost — Reconnecting...
        </div>
      )}
      {/* Every screen is the server's on screen: a switch remounts it, so nothing of the last one stays. */}
      <main key={session.serverId ?? "none"} className="flex-1 min-h-0 flex flex-col">
        {screen}
      </main>
      {keyboard === 0 && (
        <TabBar
          tab={router.tab}
          botsEnabled={botsEnabled}
          onSelect={(tab) => router.navigate([tab], undefined, { replace: true })}
        />
      )}
      <ToastContainer
        toasts={session.toast.toasts}
        onDismiss={session.toast.dismissToast}
        className="bottom-auto left-3 right-3 top-[calc(env(safe-area-inset-top)+3.5rem)] max-w-none"
      />
      <ServerPickerSheet open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
    </ServerPickerContext.Provider>
  );
}
