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
    const forceFire = /[?&]fire=1/.test(location.search);
    const fireLog = forceFire || /[?&]firelog=1/.test(location.search);

    const bones = skinned && skinned.skeleton ? skinned.skeleton.bones : [];
    const hand = bones.find((b) => b.name === "DEF-hand.R") || null;
    if (!hand) return null;

    const handWorld = () => {
      skinned.computeWorldMatrix(true);
      return skinned.getWorldMatrix().multiply(hand.getAbsoluteMatrix());
    };

    // ---- muzzle: far end of the barrel, in the hand frame ----------------
    let muzzleLocal = null;
    const parts = scene.meshes.filter((m) => m.isEnabled() && RIFLE_RE.test(m.name)
      && m.getTotalVertices && m.getTotalVertices() > 0);
    const barrel = parts.find((m) => /barrel/i.test(m.name) && !/scope/i.test(m.name));
    if (barrel && parts.length > 1) {
      const at = (m) => m.getBoundingInfo().boundingBox.centerWorld;
      const all = parts.reduce((a, m) => a.addInPlace(at(m)), new BABYLON.Vector3()).scaleInPlace(1 / parts.length);
      const bc = at(barrel);
      const dir = bc.subtract(all);
      if (dir.lengthSquared() > 1e-10) {
        dir.normalize();
        let far = null;
        let best = -Infinity;
        for (const p of barrel.getBoundingInfo().boundingBox.vectorsWorld) {
          const d = BABYLON.Vector3.Dot(p.subtract(bc), dir);
          if (d > best) { best = d; far = p; }
        }
        if (far) muzzleLocal = BABYLON.Vector3.TransformCoordinates(far.clone(), handWorld().invert());
      }
    }
    const muzzleAt = new BABYLON.Vector3();
    function muzzle() {
      if (muzzleLocal) return BABYLON.Vector3.TransformCoordinates(muzzleLocal, handWorld(), muzzleAt);
      return muzzleAt.copyFrom(camera.position);
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

    // ---- state -----------------------------------------------------------
    let ammo = MAG;
    let cooldown = 0;
    let reloadTimer = 0;
    let trigger = false;
    let rifleUp = false;
    let shake = 0;
    let shots = 0;
    let hits = 0;
    let hitTimer = 0;
    let toastTimer = 0;
    const shakeOff = new BABYLON.Vector3();

    addEventListener("mousedown", (e) => { if (e.button === 0) trigger = true; });
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
      const ray = scene.createPickingRay(engine.getRenderWidth() * 0.5, engine.getRenderHeight() * 0.5, BABYLON.Matrix.Identity(), camera);
      const pick = scene.pickWithRay(ray, (m) => m.isPickable && m.isEnabled()
        && !RIFLE_RE.test(m.name) && !/^impact|^fx/i.test(m.name));
      const to = pick && pick.hit ? pick.pickedPoint.clone() : ray.origin.add(ray.direction.scale(RANGE));

      if (fx) {
        fx.muzzleFlash(from, Math.random() * 6.283);
        fx.shotTracer(from, to);
      }
      if (pick && pick.hit) {
        hits++;
        const n = (pick.getNormal(true) || BABYLON.Axis.Y).normalize();
        if (fx) fx.impactBurst(pick.pickedPoint, n);
        placeMark(pick.pickedPoint, n);
        markHit();
      }
      if (fireLog) {
        console.log("FIRE", shots, "ammo", ammo, "len", to.subtract(from).length().toFixed(1),
          "hit", pick && pick.hit ? pick.pickedMesh.name : "miss", "hits", hits);
      }
    }

    function update(dt, up) {
      rifleUp = !!up;
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
      } else if ((trigger || forceFire) && rifleUp && cooldown <= 0) {
        fire();
      } else if (trigger && !rifleUp && cooldown <= 0) {
        cooldown = 0.6;
        showToast("HOLD F TO RAISE THE RIFLE");
      }
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
      state: () => ({ ammo, reloadTimer, shots, hits, rifleUp, shake, hasMuzzle: !!muzzleLocal, fx: !!fx, sparks: activeSparks() }),
    };
  }

  window.createWeapon = create;
})();
