// Third-person arena test scene. Classic script: uses the global BABYLON UMD build.
(() => {
  "use strict";
  const canvas = document.getElementById("renderCanvas");
  const statusEl = document.getElementById("status");
  addEventListener("error", (e) => console.log("JSERR", e.message, e.filename, e.lineno));
  const hint = document.getElementById("hint");

  if (!window.BABYLON) {
    statusEl.textContent = "Babylon.js failed to load (vendor/babylon.js missing).";
    statusEl.classList.add("error");
    return;
  }

  // No adaptToDeviceRatio: on a HiDPI display that renders at 2-3x the CSS
  // size (4-9x the pixels) for no visible gain at this camera distance. No
  // preserveDrawingBuffer either: nothing reads the canvas back (screenshots
  // go through the compositor), and it costs a full copy every frame.
  const engine = new BABYLON.Engine(canvas, true, { stencil: true }, false);
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.56, 0.7, 0.82, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.008;
  scene.fogColor = new BABYLON.Color3(0.62, 0.74, 0.84);

  const ip = scene.imageProcessingConfiguration;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.1;
  ip.contrast = 1.05;

  // ---------------------------------------------------------------- camera
  const camera = new BABYLON.FreeCamera("thirdPerson", new BABYLON.Vector3(0, 2.4, 20), scene);
  camera.inputs.clear();
  camera.minZ = 0.08;
  camera.maxZ = 300;
  camera.fov = 0.92;

  // Juice: bloom is what makes the muzzle flash, tracers and sparks read as
  // light instead of flat geometry; the vignette keeps the eye in the middle.
  if (BABYLON.DefaultRenderingPipeline) {
    const juice = new BABYLON.DefaultRenderingPipeline("juice", true, scene, [camera]);
    juice.bloomEnabled = true;
    juice.bloomThreshold = 0.7;
    juice.bloomWeight = 0.4;
    juice.bloomKernel = 48;
    juice.vignetteEnabled = true;
    juice.vignetteWeight = 1.4;
    juice.vignetteColour = new BABYLON.Color4(0.04, 0.05, 0.09, 1);
    juice.fxaaEnabled = true;
  }

  // ---------------------------------------------------------------- lights
  const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.15), scene);
  hemi.intensity = 0.58;
  hemi.diffuse = new BABYLON.Color3(0.95, 0.97, 1);
  hemi.groundColor = new BABYLON.Color3(0.36, 0.42, 0.48);

  const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.55, -1, 0.42), scene);
  sun.position = new BABYLON.Vector3(18, 28, -20);
  sun.intensity = 2.5;
  sun.diffuse = new BABYLON.Color3(1, 0.95, 0.86);

  const fill = new BABYLON.DirectionalLight("fill", new BABYLON.Vector3(0.7, -0.3, -0.7), scene);
  fill.intensity = 0.5;
  fill.diffuse = new BABYLON.Color3(0.72, 0.84, 1);

  const shadows = new BABYLON.ShadowGenerator(1024, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = 0.0008;
  shadows.normalBias = 0.02;
  shadows.darkness = 0.35;

  // ---------------------------------------------------------------- arena
  const arena = window.Arena.build(scene);
  // Only solid, meaningful pieces cast. Rails, balusters, nosings, trim and the
  // lamp are thin decorations: they used to add ~40 draws to the shadow pass
  // every frame for shadows nobody can see. Everything static is also frozen
  // so its world matrix is not recomputed each frame.
  const castsShadow = /^(wall|tower|step|stairLanding|catwalk|crate|cover|ledge|pillar|ramp|rock|tunnel)/;
  for (const mesh of arena.meshes) {
    if (castsShadow.test(mesh.name)) shadows.addShadowCaster(mesh);
    mesh.freezeWorldMatrix();
  }

  // ---------------------------------------------------------------- asset
  // The rifle is baked into this GLB as a child of DEF-hand.R (Blender:
  // tools/blender/fit_rifle.py), so there is no runtime gun placement any more.
  const LOCAL_URL = "game-ready/character_rifle.glb?v=11";
  const GUN_URL = "game-ready/pirate_rifle.glb?v=1";
  function embeddedBlobUrl() {
    const b64 = window.QUATERNIUS_GLB_BASE64;
    if (!b64) return null;
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
  }
  const blobUrl = location.protocol === "file:" ? embeddedBlobUrl() : null;
  const assetUrl = blobUrl || LOCAL_URL;

  function fail(message) {
    statusEl.textContent = message;
    statusEl.classList.add("error");
    statusEl.classList.remove("hidden");
  }

  // ---------------------------------------------------------------- input
  const keys = new Set();
  let jumpQueued = false;
  addEventListener("keydown", (e) => {
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.code === "Space" && !e.repeat) jumpQueued = true;
    if (e.code === "KeyR" && window.__player) {
      window.__player.reset();
      if (window.__weapon) window.__weapon.reset();
    }
    if (e.code === "KeyU" && window.__player && window.__player.nextCamera) window.__player.nextCamera();
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  let player = null;
  let animator = null;
  let footIK = null;
  let weapon = null;
  let gunMount = null;
  let gunLoaded = false;
  // Rifle binding: the mesh follows the DEF-hand.R bone matrix (see setup).
  let rifleRoot = null;
  let rifleSkin = null;
  let handBone = null;
  let gunOffset = null;
  let rifleBarrel = null;
  const gunProbe = /[?&]gunprobe=1/.test(location.search);
  let probeFrames = 0;

  // ---------------------------------------------------------------- rifle
  // Attached to the right hand bone so it follows the arm through every clip.
  // The model is 1.36 m long in its own space; scaled to a game-held rifle and
  // rotated so the barrel follows the hand's forward axis. Not embedded for
  // file:// (13 MB would make the base64 bundle unusable); serve it instead.
  const GUN_SCALE = 0.7;
  let gunHand = null;
  let gunHandL = null;
  let gunSkin = null;
  let gunFitQ = null;
  let gunAnchor = null;
  let gunForward = null;

  // Shortest rotation taking direction a onto direction b (v * R).
  function rotationFromTo(a, b) {
    const q = new BABYLON.Quaternion();
    const d = BABYLON.Vector3.Dot(a, b);
    if (d > 0.999999) return BABYLON.Quaternion.Identity();
    if (d < -0.999999) {
      let axis = BABYLON.Vector3.Cross(BABYLON.Axis.Y, a);
      if (axis.lengthSquared() < 1e-6) axis = BABYLON.Vector3.Cross(BABYLON.Axis.X, a);
      BABYLON.Quaternion.RotationAxisToRef(axis.normalize(), Math.PI, q);
      return q;
    }
    const axis = BABYLON.Vector3.Cross(a, b).normalize();
    BABYLON.Quaternion.RotationAxisToRef(axis, Math.acos(Math.min(1, Math.max(-1, d))), q);
    return q;
  }

  function rotateByQ(v, q) {
    const m = new BABYLON.Matrix();
    BABYLON.Matrix.FromQuaternionToRef(q, m);
    return BABYLON.Vector3.TransformNormal(v, m);
  }

  // Rotates the model so its barrel lies on +Z and its scope points +Y, i.e.
  // the same axes the body uses. Measured from the mesh bounds, never guessed.
  function fitAxes(barrel, up) {
    const q1 = rotationFromTo(barrel, BABYLON.Axis.Z);
    const up1 = rotateByQ(up, q1);
    const roll = -Math.atan2(up1.x, up1.y);
    const q2 = new BABYLON.Quaternion();
    BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.Z, roll, q2);
    const out = new BABYLON.Quaternion();
    q1.multiplyToRef(q2, out);
    return out;
  }



  function attachGun(skinned) {
    if (!skinned || !skinned.skeleton || gunLoaded) return;
    const hand = skinned.skeleton.bones.find((b) => b.name === "DEF-hand.R");
    if (!hand) return;
    gunLoaded = true;
    gunHand = hand;
    gunHandL = skinned.skeleton.bones.find((b) => b.name === "DEF-hand.L") || null;
    gunSkin = skinned;
    gunMount = new BABYLON.TransformNode("gunMount", scene);
    gunMount.rotationQuaternion = BABYLON.Quaternion.Identity();
    if (location.protocol === "file:") return;
    BABYLON.SceneLoader.ImportMeshAsync(null, "", GUN_URL, scene, null, ".glb").then((res) => {
      for (const node of res.transformNodes) if (!node.parent) node.parent = gunMount;
      // The model ships with 18 textures (nearly all of its 13 MB). At gameplay
      // size they were the frame cost: they are replaced with flat colours
      // sampled from the same parts, and the glass display is dropped.
      const COLORS = {
        Body_2: "#6b4526",
        Barrel_2: "#26262a",
        Scope_2: "#1f2022",
        Metal_Parts_2: "#3b3d40",
        Rivets_2: "#93826a",
        Straps_2: "#4d3520",
      };
      const old = new Set();
      for (const mesh of res.meshes) {
        if (!mesh.parent) mesh.parent = gunMount;
        mesh.isPickable = false;
        const matName = mesh.material ? mesh.material.name : "";
        if (matName === "Glass_0" || /glass/i.test(mesh.name)) { mesh.setEnabled(false); continue; }
        if (mesh.material) old.add(mesh.material);
        const mat = new BABYLON.StandardMaterial("gun_" + (matName || mesh.name), scene);
        mat.diffuseColor = BABYLON.Color3.FromHexString(COLORS[matName] || "#3a3a3c");
        mat.specularColor = new BABYLON.Color3(0.16, 0.16, 0.18);
        mat.specularPower = 48;
        mat.freeze();
        mesh.material = mat;
      }
      for (const m of old) m.dispose();

      // Fit the model's own axes: measure where the barrel and the scope sit
      // relative to the gun's centre in mount space, then rotate the barrel
      // onto +Z and the scope onto +Y. See tools/gun-fit.cjs.
      gunMount.computeWorldMatrix(true);
      const list = res.meshes.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0);
      for (const m of list) m.computeWorldMatrix(true);
      if (list.length >= 2) {
        // Mesh centres come back in world space; the fit must be measured in
        // the mount's own space, or the mount's current yaw leaks into it.
        const inv = gunMount.getWorldMatrix().clone().invert();
        const at = (m) => BABYLON.Vector3.TransformCoordinates(m.getBoundingInfo().boundingBox.centerWorld, inv);
        const center = list.reduce((a, m) => a.addInPlace(at(m)), new BABYLON.Vector3()).scaleInPlace(1 / list.length);
        const barrelMesh = list.find((m) => /barrel/i.test(m.name));
        const scopeMesh = list.find((m) => /scope/i.test(m.name));
        if (barrelMesh && scopeMesh) {
          gunFitQ = fitAxes(at(barrelMesh).subtract(center).normalize(), at(scopeMesh).subtract(center).normalize());
        }
      }
    }).catch((err) => console.warn("rifle not loaded:", err && err.message));
  }

  // The hand bone moves the rifle, but the rifle itself stays level with the
  // body and points where the body points: a grip welded to the wrist twists
  // with every wrist keyframe, which is what made the hold look wrong.
  function placeGun() {
    if (!gunMount || !player) return;
    // Built from the controller's facing vector, not the mesh matrix: the glTF
    // carries its own axis conversion, so any "body" rotation read from the
    // mesh put the rifle up the character's back.
    const f = player.state.facing;
    const forward = new BABYLON.Vector3(Math.sin(f), 0, Math.cos(f));
    const right = new BABYLON.Vector3(forward.z, 0, -forward.x);
    // Anchored on the aim clip's own right hand. Measured with
    // tools/pose-probe.cjs at mid-clip, the wrist sits at 0.187 m to the
    // character's right, 1.403 m up and 0.374 m forward of the feet; the mount
    // origin goes 5 cm past it so the grip lands in the palm.
    const p = player.state.pos
      .add(new BABYLON.Vector3(0, 1.40, 0))
      .addInPlace(forward.scale(0.42))
      .addInPlace(right.scale(0.19));
    // The rifle's barrel is its local +Z (Blender -Y becomes glTF +Z), and
    // RotationYawPitchRoll(f) sends +Z to (sin f, 0, cos f) = the facing
    // vector, so the yaw is f itself. The old f + PI pointed it backwards.
    const yaw = BABYLON.Quaternion.RotationYawPitchRoll(f, 0, 0);
    gunMount.freezeWorldMatrix(
      BABYLON.Matrix.Compose(
        new BABYLON.Vector3(GUN_SCALE, GUN_SCALE, GUN_SCALE),
        gunFitQ ? gunFitQ.multiply(yaw) : yaw,
        p
      ),
      false,
      true
    );

    gunAnchor = p;
    gunForward = forward;
  }

  // Hand IK: the clip supplies the arm pose, this pins the palms onto the
  // rifle (right hand on the grip, left on the foregrip). Runs after the
  // animations write the bones, so it needs its own hook. The correction is
  // capped at 8 cm, so a clip that reaches nowhere near the gun is left alone.
  function pinHands() {
    if (!gunAnchor || !gunSkin) return;
    const body = gunSkin.getWorldMatrix();
    let moved = false;
    if (gunHand) moved = pinHand(gunHand, gunAnchor.subtract(gunForward.scale(0.05)), body) || moved;
    if (gunHandL) moved = pinHand(gunHandL, gunAnchor.add(gunForward.scale(0.12)), body) || moved;
    if (moved && gunSkin.skeleton) gunSkin.skeleton.prepare();
  }

  // Moves one hand bone so its palm reaches the grip point, in bone-parent
  // space so it composes with the animated pose. Returns true if it moved.
  function pinHand(bone, targetWorld, body) {
    const cur = BABYLON.Vector3.TransformCoordinates(bone.getAbsolutePosition(), body);
    const d = targetWorld.subtract(cur);
    const len = d.length();
    if (len < 1e-3 || len > 0.25) return false;
    d.scaleInPlace(Math.min(len, 0.08) / len);
    const parent = bone.getParent ? bone.getParent() : null;
    const parentWorld = parent && parent.getAbsoluteMatrix
      ? parent.getAbsoluteMatrix().multiply(body)
      : body;
    const toLocal = parentWorld.getRotationMatrix().clone().invert();
    const local = BABYLON.Vector3.TransformNormal(d, toLocal);
    bone.setPosition(bone.position.add(local));
    return true;
  }

  function setup(imported) {
    const visible = imported.filter((m) => m.getTotalVertices && m.getTotalVertices() > 0);
    if (!visible.length) return false;

    const roots = imported.filter((m) => !m.parent);
    const mannequin = new BABYLON.TransformNode("mannequin", scene);
    roots.forEach((m) => { m.parent = mannequin; });

    // The baked rifle needs flat materials (its textures were stripped) and
    // stays out of the shadow pass: 29k triangles of gun is not worth a shadow.
    const isRifle = (n) => /Body\.002|Barrel|Scope|Metal Parts|Rivets|Straps/i.test(n || "");
    let tris = 0;
    let joints = 0;
    for (const mesh of imported) {
      if (mesh.getTotalVertices && mesh.getTotalVertices() > 0) {
        if (!isRifle(mesh.name)) shadows.addShadowCaster(mesh);
        mesh.receiveShadows = true;
        mesh.isPickable = false;
        tris += mesh.geometry && mesh.geometry.getTotalIndices ? mesh.geometry.getTotalIndices() / 3 : 0;
        if (mesh.skeleton && Array.isArray(mesh.skeleton.bones)) joints = Math.max(joints, mesh.skeleton.bones.length);
      }
    }
    const RIFLE_PARTS = [
      [/glass/i, null],
      [/barrel/i, "#26262a"],
      [/scope/i, "#1f2022"],
      [/metal/i, "#3b3d40"],
      [/rivet/i, "#93826a"],
      [/strap/i, "#4d3520"],
      [/body\.002/i, "#6b4526"],
    ];
    for (const mesh of imported) {
      const part = RIFLE_PARTS.find(([re]) => re.test(mesh.name || ""));
      if (!part) continue;
      if (!part[1]) { mesh.setEnabled(false); continue; }
      const mat = new BABYLON.StandardMaterial("rifle_" + mesh.name, scene);
      mat.diffuseColor = BABYLON.Color3.FromHexString(part[1]);
      mat.specularColor = new BABYLON.Color3(0.16, 0.16, 0.18);
      mat.freeze();
      mesh.material = mat;
      mesh.isPickable = false;
    }

    // The rifle is skinned to the same skeleton, so pick the body by name:
    // foot IK and bone maths must not latch onto a 30k-triangle gun mesh.
    const skinned = visible.find((m) => m.skeleton && !isRifle(m.name));
    if (skinned && skinned.skeleton) skinned.skeleton.useTextureToStoreBoneMatrices = true;

    // glTF turns a joint-parented mesh into a STATIC copy of that node (measured:
    // the rifle did not move at all between animation frames), so it has to be
    // driven from the animated bone matrix. The offset from the hand's rest
    // frame is measured once here; the loop then re-applies it every frame.
    rifleSkin = skinned;
    const bones = skinned && skinned.skeleton ? skinned.skeleton.bones : null;
    handBone = bones ? bones.find((b) => b.name === "DEF-hand.R") || null : null;

    rifleBarrel = imported.find((m) => isRifle(m.name) && /barrel/i.test(m.name)) || null;
    // The rifle is a SKINNED mesh weighted 100% to DEF-hand.R (Blender:
    // tools/blender/fit_rifle.py), so the skeleton moves it and the engine does
    // nothing per frame. Bone-parented meshes are static in Babylon: the loader
    // copies the joint node once.

    animator = window.createAnimator(scene);
    if (/[?&]run=1/.test(location.search)) {
      let aimRunFrames = 0;
      scene.onAfterRenderObservable.add(() => {
        if (++aimRunFrames !== 6 || !animator) return;
        console.log("AIMRUN", !!animator.holdRun, "tracks", animator.holdRun ? animator.holdRun.animatables.length : 0, "weight", animator.holdRun ? animator.holdRun.weight.toFixed(2) : "none", "blend", animator.runHold ? animator.runHold().toFixed(2) : "none");
      });
    }
    player = window.createPlayer(scene, camera, arena.colliders, arena.spawn, arena.slopes);
    window.__player = player;
    window.__anim = animator;
    const camModeParam = /[?&]cammode=(\d+)/.exec(location.search);
    if (camModeParam && player.setCamera) player.setCamera(Number(camModeParam[1]));
    footIK = window.createFootIK(scene, {
      colliders: arena.colliders,
      slopes: arena.slopes,
      mesh: skinned,
      getState: () => player.state,
    });

    // Hitscan rifle on top of the baked gun: F (or right mouse) raises it, left
    // mouse fires. The muzzle is measured from the barrel mesh in the hand
    // bone's frame, so it tracks every pose.
    weapon = window.createWeapon(scene, { camera, player, skinned, statusEl });
    window.__weapon = weapon;

    document.getElementById("mTris").textContent = Math.round(tris).toLocaleString();
    document.getElementById("mJoints").textContent = String(joints || 53);
    try {
      const { minWorld, maxWorld } = mannequin.getHierarchyBoundingVectors(true);
      document.getElementById("mHeight").textContent = (maxWorld.y - minWorld.y).toFixed(2) + " m";
    } catch (err) {
      // bounds are cosmetic only
    }

    statusEl.classList.add("hidden");
    if (hint) hint.classList.remove("hidden");
    return true;
  }

  BABYLON.SceneLoader.ImportMeshAsync(null, "", assetUrl, scene, null, ".glb")
    .then((result) => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setup(result.meshes);
    })
    .catch((err) => {
      console.error(err);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      if (setup(scene.meshes.filter((m) => m.name !== "floor"))) return;
      fail("Could not load the character GLB: " + (err && err.message ? String(err.message).slice(0, 140) : "unknown error"));
    });

  // ---------------------------------------------------------------- loop
  const speedEl = document.getElementById("mSpeed");
  const stateEl = document.getElementById("mState");
  const groundEl = document.getElementById("mGround");
  const fpsEl = document.getElementById("mFps");
  const camEl = document.getElementById("mCam");
  const CAM_NAMES = ["CHASE", "FRONT", "SIDE"];
  let camShown = -1;
  let fps = 60;
  let loopDt = 1 / 60;

  // TEMP debug camera: ?cam=x,y,z,tx,ty,tz
  const dbgMatch = /[?&]cam=([^&]+)/.exec(location.search);
  const dbgCam = dbgMatch ? dbgMatch[1].split(",").map(Number) : null;
  // Debug: ?hold=1 forces the rifle hold for screenshots.
  const forceHold = /[?&]hold=1/.test(location.search);
  // Debug: ?run=1 holds W so the aim-run clip can be captured headless.
  const forceRun = /[?&]run=1/.test(location.search);
  // Debug: ?aim=1 aims without a mouse, so the aim camera can be captured headless.
  const forceAim = /[?&]aim=1/.test(location.search);

  // Right mouse aims: the controller eases the camera in over the shoulder.
  let aiming = false;
  addEventListener("mousedown", (e) => { if (e.button === 2) aiming = true; });
  addEventListener("mouseup", (e) => { if (e.button === 2) aiming = false; });
  addEventListener("blur", () => { aiming = false; });
  addEventListener("contextmenu", (e) => e.preventDefault());

  // Foot IK must run after the animation groups write the bones. In this build
  // onAfterAnimationsObservable fires BEFORE the groups are applied, so an IK
  // correction written there was silently overwritten by the idle clip every
  // frame. onAfterRenderObservable is the first point where the posed skeleton
  // is final; the correction then shows on the next frame (one frame of lag at
  // 60+ fps, invisible).
  const afterFrame = scene.onAfterRenderObservable || scene.onAfterAnimationsObservable;

  if (afterFrame) afterFrame.add(() => { if (footIK) footIK.update(loopDt); });

  if (forceRun) dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));

  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
    loopDt = dt;
    if (player && animator) {
      const cmd = {
        forward: (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0),
        right: (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0),
        sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
        jump: jumpQueued,
      };
      jumpQueued = false;
      // Rifle up also means the over-shoulder aim camera. With the plain chase
      // camera the crosshair sits on the character's own back, so an impact
      // downrange projects onto the body and reads as shooting yourself.
      const rifleUp = aiming || forceAim || forceHold || keys.has("KeyF");
      if (player.setAim) player.setAim(rifleUp);
      player.update(dt, cmd);
      // S plays the locomotion clips in reverse: the feet step backwards.
      const back = cmd.forward < 0 && cmd.right === 0;
      // F holds the rifle up; without it the arms use the locomotion clips.
      animator.update(dt, player.state.speed, player.state.grounded, player.state.justLanded, player.state.climb, back, rifleUp);
      if (weapon) weapon.update(dt, rifleUp);
      if (speedEl) speedEl.textContent = player.state.speed.toFixed(1);
      if (stateEl) stateEl.textContent = player.state.state;
      if (camEl && player.camMode !== camShown) {
        camShown = player.camMode;
        camEl.textContent = CAM_NAMES[camShown] || "CHASE";
      }
      if (groundEl) groundEl.textContent = player.state.grounded ? "GROUND" : "AIR";
      if (groundEl) groundEl.classList.toggle("air", !player.state.grounded);
    }

    fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;
    if (fpsEl) fpsEl.textContent = Math.round(fps);
    if (dbgCam && dbgCam.length === 6 && dbgCam.every((n) => Number.isFinite(n))) {
      camera.position.set(dbgCam[0], dbgCam[1], dbgCam[2]);
      camera.setTarget(new BABYLON.Vector3(dbgCam[3], dbgCam[4], dbgCam[5]));
    }
    scene.render();
  });

  addEventListener("resize", () => engine.resize());
})();
