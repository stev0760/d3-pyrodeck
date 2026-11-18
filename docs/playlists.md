# Playlists and mission downloads

A playlist rotates a server through a list of missions. Pyrodeck can also serve those missions to players who join
without them.

## Playlists

- Create named playlists with ordered mission entries (label, `.mn3` filename, optional starting level)
- Three rotation modes: Sequential (in order, looping), Shuffle (Fisher-Yates, reshuffles on loop), Weighted (random draw by weight)
- Activate/deactivate from the Playlists tab or the Server sidebar widget
- On mission completion (`"Mission over."` in stdout), server automatically stops, swaps `MissionName=` in the active profile config, and restarts. Mid-mission level transitions (`"Ending level."` followed by `"Opening level"`) do not rotate
- The hold before the restart: once the server has loaded the mission's first level again, Pyrodeck sends `$wait on` (everyone frozen, the clock paused) and counts down in chat, then quits the server through its console (`quit` with a half-close), so a player still on is told the server has gone. Per playlist, **Hold before the restart** (default 30 s, 0 restarts at once); skipped when no human is on
- Timer anchoring: queries `$netgameinfo` once on activation and once per mission rotation (never on a timer — it leaks the engine text buffer and crashes dedicated servers). Mid-mission level changes re-anchor from the cached time limit; the countdown ticks down locally and is visible in the sidebar
- Mission voting (requires time-limited game with no kill goal): announces options via `say`, players vote by typing a single digit in chat
- Voting language uses "mission" terminology throughout
- Mission downloads: with the mission host on, activating a playlist points every entry's download link at it (see [Hosting mission downloads](playlists.md#hosting-mission-downloads)); the sidebar and the editor show the result as one line, with the reason for any mission that failed
- Game-mode validation: activation is rejected (with per-entry reasons) when a playlist entry's mission doesn't support the profile's game type; rotation re-checks each entry and skips incompatible ones instead of restarting into a broken game; the editor flags offending entries with ⚠ inline
- Restart health check: each restarted server must accept the console login and answer `$servercaps` within 120 s. A crash or timeout retries once; a second failure pauses the playlist with the reason in the sidebar and a Resume button. Rotation is still best-effort: players must reconnect after each mission change, which the hold gives them time to do

## Hosting mission downloads

A player who joins a server without its mission is offered the mission's download links. Pyrodeck can host the missions itself, from the same machine, so those links work without a separate web server.

1. In the Launch panel, open **Mission Downloads**, tick **Serve missions to players who join without them**, and set:
   - **Port**: the TCP port the download listener uses (default `3002`). Forward it on your router to this machine.
   - **Public URL**: the address players reach that port at, such as `http://example.org:3002`. A dynamic-DNS name works. Pyrodeck adds `/missions/<file>`.
2. Activate a playlist: Pyrodeck points the link of every mission in it at `<public URL>/missions/<file>`. For a single mission, pick it in the Config tab and click **Host this mission**. Either way it is the same rewrite as a typed link, so the original file is kept and **Restore original** puts it back. The server offers the new link the next time it loads the mission.

   A playlist leaves alone the missions that ship with the game, entries whose file is missing, links that already point at the host, and a link you typed for a mission yourself (to host that one too, click **Host this mission**). Saving the active playlist with new missions hosts them, and so does turning the host on, or changing its public URL, while a playlist is active. A mission that cannot be rewritten (on Windows, the one the server has loaded) is reported and the rest go ahead: the playlist shows a line such as "Downloads: 9 hosted, 3 ship with the game, 1 failed", with the reason for each failure, and Pyrodeck's log lists every mission.

3. **Test** downloads the mission through the public URL from the Pyrodeck machine and compares it with the file on disk. That proves the listener works, not that players outside your network can reach it: check that from outside the LAN (a phone off Wi-Fi will do). Some routers cannot reach their own public address from inside, so a failed test from inside the LAN is not proof either.

The listener is separate from the admin panel: it answers only `GET`/`HEAD /missions/<file>.mn3` for missions in the game path's `missions/` directory, and every other path, the admin API included, gets a 404. It needs no login. It starts, stops and moves port as soon as you save, and the Launch panel shows whether it is listening. It serves the global game path; a profile with its own game path cannot host its missions.

Limits that come from the game client:

- **http only.** The game's HTTP client is built without TLS: current builds crash on an `https://` link and 1999-era ones refuse it.
- **86 characters at most** for the whole link (the download screen copies it into a 100-character buffer). A long host name plus a long mission file name can exceed it; Pyrodeck refuses with the length.
- **No resume.** An interrupted download starts over.
- **Missions that ship with the game are never hosted** and take no link: every player has them. They are `bedlam`, `bluedev`, `bside`, `bsidectf`, `chaos`, `d3`, `d3_2`, `dementia`, `frenzy`, `fury`, `havoc`, `kata12`, `mayhem`, `merc`, `poe`, `stonecutter`, `training` and `tri-pod` (`.mn3`, any case). The server itself never advertises links for `d3.mn3`, `d3_2.mn3`, `training.mn3` and `merc.mn3`. A link Pyrodeck set on one of them before 0.5.7 can still be restored.
- **1999-era clients** (retail-derived builds) accept no port in a link. To reach them as well, forward public port 80 to the listener's port and leave the port out of the public URL (`http://example.org`).
- The game window does not redraw while a download runs; it resumes when the download finishes. Pyrodeck holds each download for one second before sending, to keep clear of a divide-by-zero in the client's progress display.
