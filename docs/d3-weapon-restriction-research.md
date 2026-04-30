# D3 Multiplayer Weapon Restriction Research

Research into Descent 3 server weapon and powerup restrictions — community conventions, technical reasons, and config syntax. Compiled 2026-04-29.

---

## Why Weapons Get Restricted

Two distinct categories:

**Network/Performance (technical):** Some weapons generate excessive bandwidth — constant proximity detection, per-frame physics state, or packet-per-frame firing. On 1990s/early 2000s connections, these would lag or crash the server for all players.

**Balance (gameplay):** Some items make the game unfair or frustrating — either because they're unavoidable, luck-based, or break the risk/reward loop.

---

## Tier 1: Almost Always Banned (Network Critical)

| Weapon/Powerup | Config Key | Reason |
|---|---|---|
| **Omega Cannon** | `Omegacannon` | Framerate-dependent energy bug; historically generated a packet-per-frame on D2, flooding the server. D3 patched some of this, but it remains disabled by default out of convention and residual concern. |
| **Proximity Mines** | `Proxminepowerup` | Constant detonation-detection checks generate heavy bandwidth overhead. Every live mine has to be tracked. Community admins: "make sure you have this line." |
| **Seeker Mines** | `Seeker3pack` | Continuous seeking behavior (per-frame target updates) inflates network state. Same bandwidth category as proximity mines. |
| **Bouncing Betty** | `Betty4pack` | Explicitly labeled a "bandwidth hog" in server op guides. Bouncing physics require constant state updates per frame. |
| **Chaff** | `Chaff` | "Extreme negative effect on latency" — also breaks lock-on weapons for entire teams. Dual concern: lag + balance. |

---

## Tier 2: Balance Restrictions (Usually Banned Competitively)

| Weapon/Powerup | Config Key | Reason |
|---|---|---|
| **Invulnerability** | `Invulnerability` | Eliminates risk/reward entirely. No counter-play. |
| **Cloak / Invisibility** | `Cloak`, `Invisiblepowerup` | Enables unavoidable cheap ambush. Balance concern. |
| **Guided Missiles** | `Guided`, `4PackGuided` | Not fun / hard to use well in multiplayer. Not universally banned but frequently restricted. **Disabled by default in Pyrodeck.** |
| **Blackshark Missile** | `Blackshark` | Powerful homing weapon; overkill in smaller maps. Competitive servers often restrict. |
| **Mega Missiles** | `Mega` | High-damage area denial; sometimes restricted on bandwidth-sensitive servers. |
| **Converter** | `Converter` | Creates weapon availability imbalance. |

---

## Tier 3: Occasionally Restricted (Server-Specific)

| Item | Config Key | Reason |
|---|---|---|
| **4-pack ammo drops** | `4PackConc`, `4PackFrag`, etc. | Slows weapon escalation on competitive servers. |
| **Microwave Cannon** | `Microwave` | Disorientation effect considered cheap by some. |
| **Gunboy / Headlight** | `GunboyPowerup`, `HeadlightPowerup` | Minor novelty; disabled by default in some launchers. |

---

## Config Syntax

```ini
DisallowPowerup=Omegacannon
DisallowPowerup=Proxminepowerup
DisallowPowerup=Seeker3pack
DisallowPowerup=Betty4pack
DisallowPowerup=Chaff
DisallowPowerup=Invulnerability
DisallowPowerup=Cloak
```

**Critical:** No trailing spaces on any line — the D3 parser chokes on them silently. Names are case-insensitive (`stricmp`).

---

## Suggested Presets (for future implementation)

### Casual / Public
Remove only the worst offenders (lag + exploits):
```
Omegacannon, Proxminepowerup, Seeker3pack, Chaff, Invulnerability, Cloak
```
Good for new players and casual deathmatch. Allows most weapons.

### Competitive / Balanced
Above + balance items:
```
+ Betty4pack, Converter, 4PackConc, 4PackFrag, 4PackGuided, Guided, Blackshark
```
Emphasizes skill-based play; removes luck/powerup RNG.

### Strict / Bandwidth-Sensitive
Above + everything marginal:
```
+ Mega, GunboyPowerup, HeadlightPowerup
```
Historical best practice for lower-bandwidth environments.

### Open / Chaos
No restrictions — allow everything.

---

## Modern Context (Matcen Fork)

The traditional network-based bans (Omega, Prox, Betty) were designed for dial-up/DSL era (30–40 kbps/player). On modern broadband these weapons may be far less problematic.

Additionally, the Matcen fork makes bots participate as real players — bots will correctly use mines, seeking weapons, etc. More real-multiplayer testing is needed to determine which restrictions still make sense in 2024+ gameplay. The preset design should be revisited after real multiplayer test sessions.

---

## Sources

- [descent3launcher/README.md](https://github.com/roncli/descent3launcher/blob/master/README.md) — Modern launcher defaults & rationale
- [Descent Forum Server Operations](https://www.descentforum.net/serverops/d3dedi.htm) — Direct server config guide
- [DescentBB D3 Server Tutorial](https://www.descentbb.net/viewtopic.php?t=10539) — Practical configuration examples
- [Official Descent 3 FAQ: Dedicated Servers](http://moon.descentforum.net/D3FAQ/06.html)
- [D3 1.4 Bug List — Suncho Descent](http://www.suncho.com/buglist.html)
- [DescentDevelopers/Descent3 GitHub Wiki](https://github.com/DescentDevelopers/Descent3/wiki)
