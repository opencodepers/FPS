// Hitscan rifle: shader muzzle flash, tracer, impact ring + sparks, hit marker,
// screen shake, recoil, ammo. The rifle itself is baked onto DEF-hand.R, so the
// muzzle is measured once in that bone's frame and follows every pose.
//
// Classic script: uses the global BABYLON build and exposes window.createWeapon.
(() => {
  "use strict";

  const RATE = 0.115;        // seconds between shots (~8.7/s)
  const MAG = 30;
  const RELOAD = 1.45;       // seconds to reload once the magazine is dry
  const RANGE = 120;         // metres before a miss falls off
  const RECOIL_PITCH = 0.013;
  const RECOIL_YAW = 0.005;
  const SHAKE_PER_SHOT = 0.055;
  const SHAKE_DECAY = 3.6;
  const MARK_MAX = 20;
  const HITMARK_TIME = 110;
  // Every rifle part in the baked GLB; also keeps the gun out of its own ray.
  const RIFLE_RE = /Body\.002|Barrel|Scope|Metal Parts|Rivets|Straps/i;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function emissive(name, hex, alpha, scene) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.emissiveColor = BABYLON.Color3.FromHexString(hex);
    m.diffuseColor = BABYLON.Color3.Black();
    m.specularColor = BABYLON.Color3.Black();
    m.disableLighting = true;
    if (alpha != null) m.alpha = alpha;
    m.freeze();
    return m;
  }

  function create(scene, opts) {
    const camera = opts.camera;
    const player = opts.player;
    const skinned = opts.skinned;
    const fx = window.createFx ? window.createFx(scene, camera) : null;
    const engine = scene.getEngine();
    const ammoEl = document.getElementById("ammo");
    const crossEl = document.getElementById("crosshair");
    const hitEl = document.getElementById("hitmark");
    const toastEl = document.getElementById("toast");
    const gunHintEl = document.getElementById("gunhint");
    const forceFire = /[?&]fire=1/.test(location.search);
    const fireLog = forceFire || /[?&]firelog=1/.test(location.search);

    const bones = skinned && skinned.skeleton ? skinned.skeleton.bones : [];
    const hand = bones.find((b) => b.name === "DEF-hand.R") || null;
    if (!hand) return null;

    const handWorld = () => {
      skinned.computeWorldMatrix(true);
      return skinned.getWorldMatrix().multiply(hand.getAbsoluteMatrix());
    };

    // ---- muzzle ----------------------------------------------------------
    // The rifle is skinned, so its mesh bounds are the PRE-SKIN rest geometry:
    // measuring the barrel tip from them put the flash 16 m above and behind the
    // player (seen in the fire log). The gun is welded to DEF-hand.R, so the
    // muzzle is the hand plus the rifle's length along the facing direction,
    // which is where the aim clip holds the barrel.
    const MUZZLE_REACH = 0.55;
    const muzzleAt = new BABYLON.Vector3();
    const handAt = new BABYLON.Vector3();
    function muzzle() {
      if (!hand) return muzzleAt.copyFrom(camera.position);
      skinned.computeWorldMatrix(true);
      BABYLON.Vector3.TransformCoordinatesToRef(hand.getAbsolutePosition(), skinned.getWorldMatrix(), handAt);
      const f = player.state.facing;
      return muzzleAt.set(
        handAt.x + Math.sin(f) * MUZZLE_REACH,
        handAt.y + 0.03,
        handAt.z + Math.cos(f) * MUZZLE_REACH
      );
    }

    // ---- bullet holes ----------------------------------------------------
    const markMat = emissive("impactMat", "#0b0b0d", 0.9, scene);
    const marks = [];
    for (let i = 0; i < MARK_MAX; i++) {
      const disc = BABYLON.MeshBuilder.CreateDisc("impact" + i, { radius: 0.032, tessellation: 8 }, scene);
      disc.material = markMat;
      disc.isPickable = false;
      disc.rotationQuaternion = BABYLON.Quaternion.Identity();
      disc.setEnabled(false);
      marks.push(disc);
    }
    let markNext = 0;

    // ---- practice dummies ------------------------------------------------
    // Wooden pop-ups down the spawn lane. Each is a post, a board and a head
    // parented to a root sitting on the floor, so a hit can tip the whole rig
    // about its base. It lies there for a moment, then springs back up, which
    // keeps the range shootable without a reset key.
    const FALL_TIME = 0.4;
    const DOWN_TIME = 2.4;
    const dummyMat = new BABYLON.StandardMaterial("dummyBoard", scene);
    dummyMat.diffuseColor = BABYLON.Color3.FromHexString("#c9a06a");
    dummyMat.specularColor = BABYLON.Color3.Black();
    const dummyPostMat = emissive("dummyPostMat", "#7a5b3a", null, scene);
    const dummyBullMat = emissive("dummyBullMat", "#b2382f", null, scene);
    const FALL = new BABYLON.Quaternion();
    const dummies = [];

    for (const [x, z] of [[0, 10.1], [-2.2, 6.6], [1.6, 4.4], [-1.6, 1.4], [1.4, -1.8]]) {
      const root = new BABYLON.TransformNode("dummy", scene);
      root.position.set(x, 0, z);
      root.rotationQuaternion = BABYLON.Quaternion.Identity();
      const part = (name, w, h, d, y, mat, zOff) => {
        const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
        m.parent = root;
        m.position.y = y;
        if (zOff) m.position.z = zOff;
        m.material = mat;
        m.receiveShadows = true;
        return m;
      };
      part("dummyPost", 0.12, 0.9, 0.12, 0.45, dummyPostMat);
      part("dummyBoard", 0.62, 0.78, 0.1, 1.34, dummyMat);
      part("dummyHead", 0.28, 0.28, 0.28, 1.87, dummyMat);
      const bull = BABYLON.MeshBuilder.CreateDisc("dummyBullseye", { radius: 0.13, tessellation: 16 }, scene);
      bull.parent = root;
      bull.position.set(0, 1.34, 0.055);
      bull.material = dummyBullMat;
      const dummy = { root, t: -1 };
      root.metadata = { dummy };
      dummies.push(dummy);
    }

    // The hit can land on any child, so walk up to the root that owns the pose.
    function dummyOf(mesh) {
      for (let n = mesh; n; n = n.parent) {
        if (n.metadata && n.metadata.dummy) return n.metadata.dummy;
      }
      return null;
    }

    function updateDummies(dt) {
      const ease = (k) => 1 - (1 - k) * (1 - k);
      for (const d of dummies) {
        if (d.t < 0) continue;
        d.t += dt;
        let angle = 0;
        if (d.t < FALL_TIME) angle = Math.PI / 2 * ease(d.t / FALL_TIME);
        else if (d.t < FALL_TIME + DOWN_TIME) angle = Math.PI / 2;
        else if (d.t < FALL_TIME * 2 + DOWN_TIME) angle = Math.PI / 2 * (1 - ease((d.t - FALL_TIME - DOWN_TIME) / FALL_TIME));
        else d.t = -1;
        // +X tips the top toward -Z, i.e. away from the shooter at spawn.
        BABYLON.Quaternion.RotationAxisToRef(BABYLON.Axis.X, angle, FALL);
        d.root.rotationQuaternion.copyFrom(FALL);
      }
    }

    // ---- state -----------------------------------------------------------
    let ammo = MAG;
    let cooldown = 0;
    let reloadTimer = 0;
    let trigger = false;
    let fireQueued = false;
    let rifleUp = false;
    let aimed = false;
    let shake = 0;
    let shots = 0;
    let hits = 0;
    let hitTimer = 0;
    let toastTimer = 0;
    const shakeOff = new BABYLON.Vector3();

    // A click is QUEUED, not only sampled: a quick click releases inside the
    // same frame, and polling a held flag dropped every one of them (measured:
    // mousePressed+mouseReleased back to back = 0 shots with the rifle up).
    addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      trigger = true;
      fireQueued = true;
    });
    addEventListener("mouseup", (e) => { if (e.button === 0) trigger = false; });
    addEventListener("blur", () => { trigger = false; });
    addEventListener("contextmenu", (e) => e.preventDefault());

    function setAmmoText(text) {
      if (ammoEl) ammoEl.textContent = text;
    }

    // A click with the rifle down used to do nothing at all, which reads as
    // "shooting is broken". Say what is missing instead.
    function showToast(text) {
      if (!toastEl) return;
      toastEl.textContent = text;
      toastEl.classList.add("on");
      toastTimer = 1.4;
    }

    function markHit() {
      if (!hitEl) return;
      hitEl.classList.add("on");
      hitTimer = HITMARK_TIME / 1000;
    }

    function placeMark(p, n) {
      const mark = marks[markNext++ % MARK_MAX];
      if (fx) fx.alignZ(n, mark.rotationQuaternion);
      mark.position.copyFrom(p.add(n.scale(0.012)));
      mark.setEnabled(true);
    }

    function fire() {
      ammo--;
      shots++;
      setAmmoText(ammo + " / " + MAG);
      cooldown = RATE;
      // Recoil kicks the view up (camPitch grows downward) and jitters the yaw;
      // nothing auto-returns, so the player re-centres like in any shooter.
      player.camPitch = clamp(player.camPitch - RECOIL_PITCH, -1.1, 1.1);
      player.camYaw += (Math.random() - 0.5) * 2 * RECOIL_YAW;
      shake = Math.min(shake + SHAKE_PER_SHOT, 0.12);

      const from = muzzle().clone();
      const pickable = (m) => m.isPickable && m.isEnabled()
        && !RIFLE_RE.test(m.name) && !/^impact|^fx/i.test(m.name);
      // Over the shoulder the crosshair is a real reticle, so shoot where the
      // camera looks. In the chase camera the crosshair sits on the player’s own
      // back: that ray hit the floor ~5 m ahead and drew the impact over the
      // body, so hip fire leaves the muzzle level along the facing direction.
      let ray;
      if (aimed) {
        ray = scene.createPickingRay(engine.getRenderWidth() * 0.5, engine.getRenderHeight() * 0.5, BABYLON.Matrix.Identity(), camera);
      } else {
        const f = player.state.facing;
        ray = new BABYLON.Ray(from, new BABYLON.Vector3(Math.sin(f), 0, Math.cos(f)), RANGE);
      }
      const pick = scene.pickWithRay(ray, pickable);
      const to = pick && pick.hit ? pick.pickedPoint.clone() : ray.origin.add(ray.direction.scale(RANGE));

      if (fx) {
        fx.muzzleFlash(from, Math.random() * 6.283);
        fx.shotTracer(from, to);
      }
      if (pick && pick.hit) {
        hits++;
        const n = (pick.getNormal(true) || BABYLON.Axis.Y).normalize();
        const dummy = dummyOf(pick.pickedMesh);
        if (dummy && dummy.t < 0) dummy.t = 0;
        if (fx) fx.impactBurst(pick.pickedPoint, n);
        placeMark(pick.pickedPoint, n);
        markHit();
      }
      if (fireLog) {
        console.log("FIRE", shots, "ammo", ammo, "len", to.subtract(from).length().toFixed(1),
          "from", from.x.toFixed(2), from.y.toFixed(2), from.z.toFixed(2),
          "to", to.x.toFixed(2), to.y.toFixed(2), to.z.toFixed(2),
          "hit", pick && pick.hit ? pick.pickedMesh.name : "miss", "hits", hits);
      }
    }

    function update(dt, up, aim) {
      rifleUp = !!up;
      aimed = !!aim;
      if (crossEl) crossEl.classList.toggle("hidden", !rifleUp);
      cooldown = Math.max(0, cooldown - dt);
      if (reloadTimer > 0) {
        reloadTimer -= dt;
        if (reloadTimer <= 0) {
          ammo = MAG;
          setAmmoText(ammo + " / " + MAG);
        }
      } else if (ammo <= 0) {
        reloadTimer = RELOAD;
        setAmmoText("RELOADING");
        fireQueued = false;
      } else if (fireQueued || trigger || forceFire) {
        if (rifleUp && cooldown <= 0) fire();
        else if (!rifleUp && cooldown <= 0) {
          cooldown = 0.6;
          showToast("HOLD F TO RAISE THE RIFLE");
        }
        fireQueued = false;
      }
      // Says what is missing until the first shot lands, then stays out of the way.
      if (gunHintEl) gunHintEl.classList.toggle("on", !rifleUp && shots === 0);
      updateDummies(dt);
      if (fx) fx.update(dt);

      if (hitTimer > 0) {
        hitTimer -= dt;
        if (hitTimer <= 0 && hitEl) hitEl.classList.remove("on");
      }
      if (toastTimer > 0) {
        toastTimer -= dt;
        if (toastTimer <= 0 && toastEl) toastEl.classList.remove("on");
      }

      // Screen shake: the camera was already placed by the controller this
      // frame, so a decaying random offset here reads as an impulse and is
      // overwritten next frame.
      if (shake > 0) {
        shakeOff.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake * 0.6, (Math.random() - 0.5) * shake);
        camera.position.addInPlace(shakeOff);
        shake = Math.max(0, shake - dt * SHAKE_DECAY * shake - dt * 0.02);
      }
    }

    function reset() {
      ammo = MAG;
      cooldown = 0;
      reloadTimer = 0;
      shots = 0;
      hits = 0;
      shake = 0;
      setAmmoText(ammo + " / " + MAG);
    }

    setAmmoText(ammo + " / " + MAG);
    const activeSparks = () => (!fx || !fx.sparks ? -1
      : fx.sparks.getActiveCount ? fx.sparks.getActiveCount() : (fx.sparks.particles || []).length);
    return {
      update, fire, reset,
      state: () => ({ ammo, reloadTimer, shots, hits, rifleUp, shake, queued: fireQueued, down: dummies.filter((d) => d.t >= 0).length,
        muzzle: [+muzzle().x.toFixed(2), +muzzle().y.toFixed(2), +muzzle().z.toFixed(2)], hasMuzzle: !!hand, fx: !!fx, sparks: activeSparks() }),
    };
  }

  window.createWeapon = create;
})();
