# Several servers

One Pyrodeck runs several servers at once, each from its own profile. The Launch panel lists them, every profile's
server with its state, mission and level, humans, game type, playlist and ports, and each has its own **Start** or
**Stop**. Click a server to show it: every tab (Output, Console, Players, Bots, the server card, Playlists, Logs,
Rules, Config) is then about that server, and its name stays in the header. On a phone, tap the server's name at the
top of any screen to pick another.

To run a second server beside the first:

1. **+ New Profile** in the Launch panel, or import its launch script.
2. Give it its own ports. Each server needs its own game port (Edit → Launch Options → Game port, `-useport`; 2092 is
   the default) and console port (Config tab → Remote Console → Port). The GameSpy port moves to a free one by itself
   when another server holds 20142, unless the profile sets one.
3. A shared game directory is fine. Each profile has its own server config file, and a profile created where another
   already runs from gets its own Startup Commands file (Edit → Startup Commands File). Each server gets its own temp
   directory. The tracker list is shared: servers of one game directory read the same `gamespy.cfg` unless a profile
   names its own GameSpy file (Edit → Launch Options), and Edit → Tracker Listing says which profiles share it.
4. Open each server's UDP game port in the firewall, as for the first, and its GameSpy port if it is listed on a
   tracker. Set that port in Launch Options so it stays the same at every launch.

Pyrodeck refuses a launch that would clash with a running server, and says which server and what to change: the same
game, GameSpy or console port, the same server config, the same Startup Commands file (while it exists or the profile
has team settings to write into it), or the same temp directory. Nothing you set is changed for you.

Playlists are shared by all servers: open one in the Playlists tab and **Activate on** the server on screen; each
server rotates its own, and the list shows where each playlist is active. Supervisor settings, bans, join rules and the
Settings tab apply to all servers. To start several servers with Pyrodeck, see Autostart under
[Operations](operations.md).

**Upgrading from 0.5.x** needs nothing: the first start adds `servers/` to the config directory and re-attaches to the
running server. **Going back to 0.5.x**, stop every server but one first: an older Pyrodeck knows one server and
re-attaches to it; the others would keep running unseen.
