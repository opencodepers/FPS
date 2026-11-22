## Agent skills (always on)

Custom skill group written by the project owner. Always active in every session
and every agent, until "stop hyperlean" / "normal mode". Installed in
`.agents/skills/`:

- **hyperlean** (full) - always on: terse output, smallest complete change,
  scope contract, focused verification.
- **hyperslop** - anti-slop gate (code, UI, copy).
- **hypershell** - shell command discipline.
- **ponytail** - smallest complete change.
- **yagni** - scope discipline.
- **cavemenko** - terse replies.

Load `hyperlean` before editing anything in this repo. Entry points:

- `.agents/skills/hyperlean/SKILL.md` (mode: full)
- `.agents/skills/hyperslop/SKILL.md`
- `.agents/skills/hypershell/SKILL.md`
- `.agents/skills/ponytail/SKILL.md`, `.agents/skills/yagni/SKILL.md`, `.agents/skills/cavemenko/SKILL.md`

One copy serves every harness that reads this file - keep it that way; do not
duplicate or reword the skills.


## Project facts

- No build step. `index.html` + `js/*.js`, must work over `file://`:
  the character GLB is base64-embedded in `assets/quaternius-mannequin.js`.
- Dev server: `node server.mjs` -> http://localhost:5173 (no-store).
- Verify: `node tools/test-controller.cjs` (69 checks) + `node --check js/*.js`.
- Character: `game-ready/character_rifle.glb` is generated. Never hand-edit it;
  regenerate with
  `"/c/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background --factory-startup --python tools/blender/fit_rifle.py`
  then repack `assets/quaternius-mannequin.js` from it.
- Aim-run body motion is baked into the GLB as `Aim_Run_Loop`; the engine
  cross-fades to it from the frozen aim pose (`js/animations.js`).
- Rifle placement lives in `tools/blender/fit_rifle.py`: `RIFLE_NUDGE` is a
  rest-hand-local nudge (metres); `None` auto-solves the smallest shift that
  clears the forearm capsule. To place it by hand, open
  `game-ready/character_rifle.blend`, set the armature to Rest Position, move the
  rifle meshes (skinned 100% to `DEF-hand.R`), then re-export and repack.
- Bones: pelvis is `DEF-hips` (not `DEF-pelvis`); slices in
  `js/animations.js` (UPPER / LOWER / AIM_RUN) must match real bone names.
- Debug URL hooks: `?aim=1` (aim camera without a mouse), `?cammode=N`, `?hold=1`, `?run=1`, `?cam=x,y,z,tx,ty,tz`.

## Git

- Commit and push only when the user asks. Never commit or push on your own,
  and never bundle a commit into an unrelated request.
