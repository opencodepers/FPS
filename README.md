# Quaternius Mannequin — Babylon.js

Babylon.js scene for the FPS project, built around the character that ships with
Quaternius' **Universal Animation Library** (CC0).

The character, its 53-bone skeleton and all 46 clips are authored together, so
nothing is retargeted: the glTF animations play directly on their own rig.

## Run

```bash
npm start
# http://localhost:5173
```

No install step and no bundler: Babylon is vendored as a classic UMD script, so
the page also opens by double-clicking `index.html`. `file://` builds a Blob URL
from the embedded GLB in `assets/quaternius-mannequin.js`.

## Files

| path | purpose |
| --- | --- |
| `index.html` | canvas, HUD, clip picker, script wiring |
| `js/main.js` | scene, lights, shadows, input, HUD wiring |
| `js/world.js` | blockout arena: floor, walls, stairs, tunnel, crates, colliders |
| `js/controller.js` | third-person capsule controller + spring-arm camera |
| `js/animations.js` | speed-driven blending of idle/walk/jog/sprint/jump/land |
| `js/footik.js` | per-foot ground probes, pelvis drop, 2-bone leg IK, foot leveling |
| `vendor/babylon.js` | vendored Babylon UMD core build |
| `vendor/babylon.glTF2FileLoader.js` | Babylon UMD glTF/GLB loader |
| `assets/quaternius-mannequin.js` | GLB as base64, for `file://` |
| `game-ready/quaternius_mannequin.glb` | character + skeleton + 46 clips |
| `game-ready/pirate_rifle.glb` | stylized rifle, attached to `DEF-hand.R` |
| `tools/stride.cjs` | measures a clip's authored ground speed from its keyframes |
| `tools/pack-character.mjs` | packs the source glTF into that GLB |
| `tools/anim-src/quaternius/` | CC0 source glTF, bin and license |
| `server.mjs` | dependency-free static server |

## Animation

Every clip in the free Standard release is available from the HUD's CLIP menu:
idle (plain, talking, torch), jog, sprint, walk, walk formal, crouch walk/idle,
jump start/loop/land, push, swim, roll, sit, pick up, punch, pistol
aim/idle/shoot/reload, sword attacks/idle, spell, dance, death, hits, interact.

Clips are in-place and not retargeted. `js/animations.js` blends by speed and
scales playback by the distance covered per stride (including the slope), and
`js/footik.js` does the final per-foot placement on the ground.

The walk clip's stance phase covers 1.05 m/s of ground, measured with
`node tools/stride.cjs`, so it plays at ~1.9x while the controller walks at
2.0 m/s: the feet stay in step with the floor instead of skating. Holding S
plays the locomotion clips backwards (negative speed ratio), so backing up
steps backwards instead of moon-walking forwards.

## Arena test

The scene is a third-person shooter test arena rather than a viewer: the mouse
aims the camera and the character always faces where the camera looks, so A/D
strafe and S backs up without turning the body. Everything is built from box
colliders so the movement can be measured.

- **Controls:** W/S forward and back, A/D strafe (camera-relative), Shift
  sprint, Space jump, R reset, mouse look (click to capture, Esc to release),
  hold right mouse to aim, U cycles the camera.
- **Aim:** holding right mouse eases the spring arm in from 4.3 m to 1.75 m
  over the right shoulder, raises the pivot to the head and narrows the field
  of view from 0.8 to 0.62 rad. Releasing it eases back out; the same rates
  are used both ways, so the switch is one smooth move.
- **Rifle:** `placeGun` in `js/main.js` puts the rifle at the right hand's
  world position but keeps it level with the body and pointing where the body
  points, so the grip does not twist with the wrist. The character stands in
  the pack's pistol-aim stance (`Pistol_Aim_Neutral`).
- **Feel numbers:** walk 2.0 m/s, sprint 7.4 m/s (jog blends in through
  acceleration), gravity 22 m/s²,
  jump ≈ 1.3 m, auto step-up 0.45 m, acceleration 30 m/s², ground friction
  26 m/s².
- **Course:** open sprint lane from spawn, two stair flights (17 rises) to a
  3.02 m tower and catwalk, 2 m wide tunnel with a low ceiling, crate stacks,
  low cover, a 2.4 m jump gap between two 1.2 m ledges, a 3-step staging
  area near spawn, a 6 m ramp to a 1.2 m landing on the west side, and a low
  sloped rock in the north open area.
- **Stairs:** 7 in rise / 11 in tread (0.178 / 0.279 m, so 2R + T = 0.635 m =
  25 in), uniform bottom to top: eight rises, a 1.2 m landing, nine more rises,
  with handrails, posts, a baluster per nosing and nosing strips. The
  controller follows the tread under the capsule centre, so 0.28 m treads work
  at walk and sprint speeds, walls and crates still block, and step changes are
  eased visually over ~0.1 s instead of popping.
- **Foot IK:** `js/footik.js` runs after the animation and before drawing.
  It casts a short downward ray under each heel and ball and plants each foot
  on the surface beneath it with a 2-bone hip/knee/ankle solve, so standing
  with one foot on a step or ledge and the other on the floor is a real
  stance. When a planted leg cannot reach its surface the pelvis sinks (up to
  0.45 m) and the foot stays there; only a foot beyond that reach (for example
  one over a 3 m drop) is slid back onto the platform at its height. Feet are
  rotated onto the surface normal, including the ramp and rock planes. The
  swing foot keeps the clip while moving, so walking does not turn into
  dragging.
- **Edges:** the controller samples a four-point stance footprint. The centre
  may pass an edge while a foot is still on it, but only when the drop below
  the centre is within the 0.45 m leg reach (a step straddle). On a tall ledge
  or the side of the ramp the support is withdrawn and the body falls, so it
  never hovers on one leg with the other dangling in the air. Leaving a ledge
  never shoves the capsule sideways.
- **Camera:** spring arm 4.3 m, orbits with the mouse and pulls in when a wall,
  ceiling, the ramp or the rock blocks the line to the character; the arm never
  passes through a sloped surface, top or side. **U** cycles three camera
  modes — chase (behind), front (facing the character) and side — and the mode
  yaw is eased at 9 Hz so the view swings around the body instead of cutting.
  The HUD shows the active mode next to `CAM`.

`node tools/test-controller.cjs` runs the headless checks: walk/sprint/jump,
wall collision, stair geometry, climbing and descending, climb/lean, slow
timesteps, step blocks, camera, camera-locked facing and strafing, and foot IK
on the floor, a tread and airborne feet.

### Foot IK limits

The solver plants the support foot and, while standing, the other foot too, so
a step straddle is held rather than skipped. The pelvis drop is capped at
0.45 m (a deep lunge), which keeps the stretch believable without letting the
body sink through the floor; a foot further down than that is placed back on
the platform. It follows planar surfaces — flat box tops and the ramp/rock
planes — and tips each sole onto the surface normal; curved or multi-faceted
tops are not supported. It corrects position and foot angle, not full sole
warping. The pack has no
lateral strafe clips, so A/D plays the forward locomotion clips while the body
keeps the camera heading; dedicated strafe animations would remove the
sidestep skating. Mocap contact events, additive breathing, aim/look-at offsets
and motion matching are not part of this locomotion test scene.

## Credits

Character and animations: Quaternius — Universal Animation Library
(quaternius.com), CC0 1.0. See `game-ready/CREDITS.txt`.

