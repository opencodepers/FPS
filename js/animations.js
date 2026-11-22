// shortcut: directional (strafe) blend space needs strafe clips not in asset set; backward uses reversed locomotion. Full 2D blend space requires strafe clips.
// Speed-driven animation blending for the Quaternius character.
//
// Legs come from the locomotion clips as authored. Holding F adds an upper-body
// layer on top, so the rifle stays up while running and the arms go back to the
// normal swing when F is released.
//
// The aim-run torso twist is BAKED into the GLB as "Aim_Run_Loop" (Blender:
// tools/blender/fit_rifle.py): the aim pose plus one stride of waist, neck and
// head movement. Standing still uses the frozen aim pose instead, so the arms
// never drift when there is no stride to follow.
(() => {
  "use strict";

  const CLIPS = {
    idle: "Idle_Loop",
    hold: "Pistol_Aim_Neutral",
    aimRun: "Aim_Run_Loop",
    walk: "Walk_Loop",
    jog: "Jog_Fwd_Loop",
    sprint: "Sprint_Loop",
    jump: "Jump_Loop",
    land: "Jump_Land",
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // Ground speed Walk_Loop was authored for, measured from the clip's own
  // stance phase (tools/stride.cjs: the planted foot travels at 1.05 m/s).
  const WALK_REF = 1.05;
  const WALK_SPEED = 2.0;

  // The hold layer only writes these bones, so it cannot disturb the legs.
  const UPPER = /^DEF-(spine|neck|head|shoulder|upper_arm|forearm|hand|thumb|palm|f_)/i;
  // The aim-run layer also owns the hips: the legs' slices write the pelvis, so
  // this clip has to be applied after them to turn the hips with the ribcage.
  // Arms excluded: frozen aim pose keeps rifle stable; only hips/spine/neck/head
  // follow the baked stride so the body twists without hands swaying.
  const AIM_RUN = /^DEF-(hips|pelvis|spine|neck|head)$/i;
  // DEF-hips is the pelvis bone in this rig - without it here the hips were
  // never driven by the leg slices and froze the moment the arms took over.
  const LOWER = /^DEF-(hips|pelvis|thigh|shin|foot|toe|root)/i;
  const HOLD_WEIGHT = 1;   // the arms have no competition, so 1 is exact

  function create(scene) {
    const groups = {};
    for (const [key, name] of Object.entries(CLIPS)) {
      if (key === "hold" || key === "aimRun") continue;
      groups[key] = scene.animationGroups.find((g) => g.name === name) || null;
      if (!groups[key]) console.warn("missing clip", name);
    }

    // Upper-body copy of a clip: only its arm, chest, neck and head tracks, so
    // it can play over the legs without the two fighting.
    function upperGroup(name, source, weight, filter = UPPER) {
      if (!source) return null;
      const g = new BABYLON.AnimationGroup(name, scene);
      for (const ta of source.targetedAnimations) {
        if (filter.test((ta.target && ta.target.name) || "")) g.addTargetedAnimation(ta.animation, ta.target);
      }
      g.stop();
      g.start(true, 1, source.from, source.to, false);
      g.weight = weight;
      return g;
    }

    // Frozen aim pose: the rifle is fitted to the MIDDLE of the aim clip, so
    // that frame is what standing still shows. Looping the clip swept the arms
    // back through the rest pose and put the rifle wherever the wrist was.
    let hold = null;
    let holdMid = 0;
    const holdSource = scene.animationGroups.find((g) => g.name === CLIPS.hold);
    if (holdSource) {
      hold = new BABYLON.AnimationGroup("holdUpper", scene);
      for (const ta of holdSource.targetedAnimations) {
        if (UPPER.test((ta.target && ta.target.name) || "")) hold.addTargetedAnimation(ta.animation, ta.target);
      }
      const mid = holdSource.from + (holdSource.to - holdSource.from) * 0.5;
      hold.from = mid;
      hold.to = mid;
      holdSource.weight = 0;
      hold.stop();
      hold.start(true, 1, mid, mid, false);
      hold.weight = 0;
      holdMid = mid;
    }

    // Baked aim-run: same pose, with the waist and head moving for one stride.
    const runSource = scene.animationGroups.find((g) => g.name === CLIPS.aimRun) || null;

    // Holding hands the legs to lower-body slices of the same clips. Without
    // them the full-body locomotion clips still wrote the arms, and blending
    // two different arm poses is what twisted the aim.
    const lower = {};
    for (const key of ["idle", "walk", "jog", "sprint", "jump", "land"]) {
      const src = groups[key];
      if (!src) continue;
      const g = new BABYLON.AnimationGroup(key + "Lower", scene);
      for (const ta of src.targetedAnimations) {
        if (LOWER.test((ta.target && ta.target.name) || "")) g.addTargetedAnimation(ta.animation, ta.target);
      }
      g.from = src.from;
      g.to = src.to;
      g.stop();
      g.start(true, 1, g.from, g.to, false);
      g.weight = key === "idle" ? 1 : 0;
      lower[key] = g;
    }

    // Created AFTER the leg slices on purpose: group order decides who wins the
    // pelvis, and the baked hip turn must beat the leg slices' pelvis track.
    const holdRun = upperGroup("holdRun", runSource, 0, AIM_RUN);
    if (runSource) runSource.weight = 0;

    for (const key of ["idle", "walk", "jog", "sprint", "jump", "land"]) {
      const g = groups[key];
      if (!g) continue;
      g.stop();
      g.start(true, 1, g.from, g.to, false);
      g.weight = key === "idle" ? 1 : 0;
    }

    const weights = { idle: 1, walk: 0, jog: 0, sprint: 0, jump: 0, land: 0 };
    let landTimer = 0;
    let current = "idle";
    let holdWeight = 0;
    let runHold = 0;

    function setRatio(key, ratio) {
      const g = groups[key];
      if (g) g.speedRatio = ratio;
      const lg = lower[key];
      if (lg) lg.speedRatio = ratio;
    }

    function update(dt, speed, grounded, landedNow, climb = 0, backward = false, holding = false) {
      if (landedNow) {
        landTimer = 0.34;
        const g = groups.land;
        if (g) { g.stop(); g.start(false, 1, g.from, g.to, false); }
      }
      if (landTimer > 0) landTimer = Math.max(0, landTimer - dt);
      if (groups.jump) groups.jump.speedRatio = 1;

      const target = { idle: 0, walk: 0, jog: 0, sprint: 0, jump: 0, land: 0 };
      if (!grounded) {
        target.jump = 1;
      } else if (landTimer > 0) {
        target.land = 1;
      } else if (speed < 0.15) {
        target.idle = 1;
      } else if (speed < WALK_SPEED) {
        const t = speed / WALK_SPEED;
        target.idle = 1 - t;
        target.walk = t;
      } else if (speed < 4.6) {
        const t = (speed - WALK_SPEED) / (4.6 - WALK_SPEED);
        target.walk = 1 - t;
        target.jog = t;
      } else {
        const t = clamp((speed - 4.6) / 2.8, 0, 1);
        target.jog = 1 - t;
        target.sprint = t;
      }

      const k = 1 - Math.exp(-14 * dt);
      // F eases the hold in instead of popping the arms.
      if (hold) holdWeight += ((holding ? HOLD_WEIGHT : 0) - holdWeight) * k;
      const hb = hold ? holdWeight / HOLD_WEIGHT : 0;

      // Standing aim uses the frozen pose; the baked aim-run clip takes over as
      // soon as there is a stride to move with. The blend keeps the arms from
      // popping and stops the twist when the character stops.
      if (holdRun) {
        // Hysteresis so the aim-run clip doesn't pop in and out at the
        // threshold speed (which made the rifle/hands "swap" while aiming).
        const moving = grounded && (runHold > 0.5 ? Math.abs(speed) > 0.6 : Math.abs(speed) > 1.1);
        runHold += ((moving ? 1 : 0) - runHold) * (1 - Math.exp(-4 * dt));
      }
      const rh = holdRun ? runHold : 0;

      for (const key of Object.keys(weights)) {
        weights[key] += (target[key] - weights[key]) * k;
        // Cross-fade: full-body clip at rest, legs-only slice while holding.
        const g = groups[key];
        if (g) g.weight = weights[key] * (1 - hb);
        const lg = lower[key];
        if (lg) lg.weight = weights[key] * hb;
      }
      if (hold) {
        // Always full weight: this clip owns the arms, and the aim-run clip
        // writes only hips/spine/neck/head. Zeroing it while running left the
        // arms with no clip at all, which snapped them into the bind pose.
        hold.weight = holdWeight;
        hold.speedRatio = 1;
        hold.goToFrame(holdMid);
      }
      if (holdRun) {
        holdRun.weight = holdWeight * rh;
        // Cadence follows the ground speed so the twist lands on the footfalls.
        holdRun.speedRatio = clamp(Math.abs(speed) / 2.2, 0.8, 1.7) * (backward ? -1 : 1);
      }

      // On a slope the foot covers sqrt(1 + climb^2) times the ground
      // distance, so the cadence is scaled by the same factor: feet stay in
      // step with the treads instead of skating up or down them.
      const slopeRatio = Math.sqrt(1 + climb * climb);
      // Backing up plays the same clips in reverse, so the feet step back
      // instead of moon-walking forward.
      const dir = backward ? -1 : 1;
      setRatio("walk", dir * clamp((speed / WALK_REF) * slopeRatio, 0.65, 2.1));
      setRatio("jog", dir * clamp((speed / 4.6) * slopeRatio, 0.6, 1.35));
      setRatio("sprint", dir * clamp((speed / 7.4) * slopeRatio, 0.65, 1.3));
      if (groups.idle) groups.idle.speedRatio = 1;

      current = target.jump ? "air" : target.land ? "landing" : target.sprint > target.jog ? "sprint" : target.jog > target.walk ? "jog" : target.walk > 0.4 ? "walk" : "idle";
      return current;
    }

    return {
      update,
      weights,
      current: () => current,
      groups,
      lower,
      hold,
      holdRun,
      aim: () => (hold ? holdWeight / HOLD_WEIGHT : 0),
      runHold: () => runHold,
    };
  }

  window.createAnimator = create;
})();
