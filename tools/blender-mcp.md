# Blender MCP — setup and what it buys this project

## What is installed

- `uv` / `uvx` 0.11.x at `C:\Users\sophi\.local\bin`
- **MCP for Blender** (community, `mcp-for-blender`, formerly `blender-mcp`, 34k stars,
  Blender 3.0+): addon at
  `%APPDATA%\Blender Foundation\Blender\5.3\scripts\addons\blender_mcp.py`
  (copied there from the 5.2 folder the installer wrote to; 5.0 also has a copy).
  Installed with `uvx mcp-for-blender install-addon`.
- Blender **5.3.0** at `C:\Program Files\Blender Foundation\Blender 5.3\blender.exe`.

Fallback if the community addon misbehaves on 5.x: the official Blender Lab MCP
(Blender 5.1+, Extensions repo, port 9876) — same job, fewer tools.

## Three steps left (Blender side)

1. Blender → **Edit → Preferences → Add-ons** → enable **Interface: MCP for Blender**
   (if it is not listed, use the Add-ons search box and refresh; the file is already
   in the 5.3 config folder).
2. In the 3D viewport press **N** → **MCP for Blender** tab → **Start MCP Server**.
   It listens on `127.0.0.1:9876` and starts with Blender from then on.
3. Add the server to the MCP client config, then **restart the client** so the
   tools appear in the session:

```json
{
  "mcpServers": {
    "blender": { "command": "uvx", "args": ["mcp-for-blender"] }
  }
}
```

CLI clients: `claude mcp add blender uvx mcp-for-blender` /
`codex mcp add blender -- uvx mcp-for-blender`.

Only one MCP server instance may talk to Blender at a time; close other clients
that also define it.

## What it will be used for here

The rifle is currently positioned at runtime (`placeGun` in `js/main.js`): chest
anchor, barrel aligned from a measured model axis. That works but is fragile and
cannot fix the grip — the pack has no rifle-hold clip, only pistol aim.

With Blender the fix is authored once instead of computed every frame:

1. Import `game-ready/quaternius_mannequin.glb` and `game-ready/pirate_rifle.glb`.
2. Parent the rifle to the `DEF-hand.R` bone at rest, barrel along the character's
   forward, grip in the palm; nudge the left hand if needed.
3. Export a single `game-ready/character_rifle.glb` (skeleton + rifle already in
   the hand) and drop `placeGun` from the engine — no offsets, no drift, no
   per-frame matrix work.
4. Optional: a rifle-ready pose from the pistol-aim clips as a starting point.

`tools/blender/probe-rig.py` prints the armature, hand/foot bones and rifle bounds
headlessly, so the first fit is done from numbers:

```bash
blender --background --python tools/blender/probe-rig.py
```

## What this does not solve

Engine-side behaviour (controller, camera modes, aim transition, backward clip
playback) stays code. Blender only removes the blind placement work.
