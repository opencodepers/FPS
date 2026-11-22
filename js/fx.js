// Game-feel effects: muzzle flash, tracer, impact shockwave and sparks.
// Everything is procedural (shaders + a generated gradient texture), so the
// arena still ships without any image assets.
(() => {
  "use strict";

  const VERT = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main(void) {
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

  // Star burst: hot core, procedural spikes, soft halo. uLife 1 -> 0.
  const FLASH = `
precision highp float;
varying vec2 vUV;
uniform float uLife;
uniform float uSeed;
void main(void) {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float ang = atan(p.y, p.x);
  float spikes = pow(abs(cos(ang * 2.5 + uSeed)), 8.0);
  float core = smoothstep(0.62, 0.0, r);
  float halo = smoothstep(1.0, 0.1, r) * 0.4;
  float a = (core * (0.55 + 1.1 * spikes) + halo) * uLife;
  vec3 col = mix(vec3(1.0, 0.48, 0.12), vec3(1.0, 0.97, 0.86), core);
  gl_FragColor = vec4(col * (1.0 + 1.3 * core), a);
}`;

  // Impact shockwave: a ring that widens as it fades.
  const RING = `
precision highp float;
varying vec2 vUV;
uniform float uLife;
void main(void) {
  vec2 p = vUV * 2.0 - 1.0;
  float r = length(p);
  float edge = 0.86 * (1.0 - uLife) + 0.06;
  float width = 0.10 + 0.30 * uLife;
  float ring = smoothstep(width, 0.0, abs(r - edge));
  float hot = smoothstep(0.55, 0.0, r) * 0.35;
  gl_FragColor = vec4(mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.95, 0.8), ring), (ring + hot) * uLife);
}`;

  // Tracer: bright at the muzzle, fading along the line, camera facing.
  const TRACER = `
precision highp float;
varying vec2 vUV;
uniform float uLife;
void main(void) {
  float across = 1.0 - smoothstep(0.0, 0.5, abs(vUV.y - 0.5) * 2.0);
  float along = pow(1.0 - vUV.x, 1.6);
  float a = across * (0.25 + 0.75 * along) * uLife;
  gl_FragColor = vec4(mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.95, 0.75), along), a);
}`;

  BABYLON.Effect.ShadersStore.fxVertexShader = VERT;
  BABYLON.Effect.ShadersStore.fxFlashFragmentShader = FLASH;
  BABYLON.Effect.ShadersStore.fxRingFragmentShader = RING;
  BABYLON.Effect.ShadersStore.fxTracerFragmentShader = TRACER;

  function radialTexture(scene) {
    const size = 64;
    const tex = new BABYLON.DynamicTexture("fxSpark", size, scene, false);
    const ctx = tex.getContext();
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.4, "rgba(255,196,110,0.8)");
    g.addColorStop(1, "rgba(255,90,20,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    tex.update(false);
    tex.hasAlpha = true;
    return tex;
  }

  function shaderMat(name, frag, scene) {
    const mat = new BABYLON.ShaderMaterial(name, scene, { vertex: "fx", fragment: frag }, {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "uLife", "uSeed"],
      needAlphaBlending: true,
    });
    mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.setFloat("uLife", 1);
    mat.setFloat("uSeed", 0);
    return mat;
  }

  // Quaternion from three orthonormal axes (x, y, z).
  function fromAxes(x, y, z, out) {
    const m = BABYLON.Matrix.FromXYZAxesToRef(x, y, z, new BABYLON.Matrix());
    BABYLON.Quaternion.FromRotationMatrixToRef(m, out);
    return out;
  }

  // Quaternion that sends local +Z along dir, used by the impact marks.
  function alignZ(dir, out) {
    const z = dir.clone().normalize();
    let x = BABYLON.Vector3.Cross(BABYLON.Axis.Y, z);
    if (x.lengthSquared() < 1e-6) x.copyFrom(BABYLON.Axis.X);
    else x.normalize();
    const y = BABYLON.Vector3.Cross(z, x).normalize();
    return fromAxes(x, y, z, out);
  }

  function create(scene, camera) {
    const flashMat = shaderMat("fxFlash", "fxFlash", scene);
    const tracerMat = shaderMat("fxTracer", "fxTracer", scene);

    const quad = (name, mat) => {
      const m = BABYLON.MeshBuilder.CreatePlane(name, { size: 1, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      m.material = mat;
      m.isPickable = false;
      m.renderingGroupId = 1;
      m.rotationQuaternion = BABYLON.Quaternion.Identity();
      m.setEnabled(false);
      return m;
    };

    const flash = quad("fxFlashQuad", flashMat);
    flash.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    const tracer = quad("fxTracerQuad", tracerMat);

    const rings = [];
    for (let i = 0; i < 4; i++) {
      const mesh = quad("fxRing" + i, shaderMat("fxRingMat" + i, "fxRing", scene));
      mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      rings.push({ mesh, life: 0, dur: 0.26, mat: mesh.material });
    }

    const sparkPos = new BABYLON.Vector3();
    const sparkDir = new BABYLON.Vector3(0, 1, 0);
    const sparks = new BABYLON.ParticleSystem("fxSparks", 90, scene);
    sparks.particleTexture = radialTexture(scene);
    sparks.emitter = sparkPos;
    sparks.startPositionFunction = (wm, out) => out.copyFrom(sparkPos);
    sparks.startDirectionFunction = (wm, out) => {
      out.copyFrom(sparkDir);
      out.x += (Math.random() - 0.5) * 0.9;
      out.y += (Math.random() - 0.5) * 0.9;
      out.z += (Math.random() - 0.5) * 0.9;
      out.normalize();
    };
    sparks.minLifeTime = 0.12;
    sparks.maxLifeTime = 0.3;
    sparks.minSize = 0.02;
    sparks.maxSize = 0.075;
    sparks.minEmitPower = 1.6;
    sparks.maxEmitPower = 5.5;
    sparks.gravity = new BABYLON.Vector3(0, -7, 0);
    sparks.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
    sparks.color1 = new BABYLON.Color4(1, 0.82, 0.4, 1);
    sparks.color2 = new BABYLON.Color4(1, 0.42, 0.12, 1);
    sparks.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    sparks.updateSpeed = 1 / 60;
    sparks.emitRate = 0;
    sparks.manualEmitCount = -1;
    sparks.start();

    const FLASH_DUR = 0.055;
    const TRACER_DUR = 0.065;
    let flashLife = 0;
    let tracerLife = 0;

    function muzzleFlash(pos, seed) {
      flash.position.copyFrom(pos);
      flash.scaling.setAll(0.5);
      flash.setEnabled(true);
      flashMat.setFloat("uSeed", seed % 6.283);
      flashMat.setFloat("uLife", 1);
      flashLife = FLASH_DUR;
    }

    function shotTracer(from, to) {
      const dir = to.subtract(from);
      const len = dir.length();
      if (len < 0.12) return;
      const x = dir.scale(1 / len);
      const toCam = camera.position.subtract(from);
      let z = toCam.subtract(x.scale(BABYLON.Vector3.Dot(toCam, x)));
      if (z.lengthSquared() < 1e-6) z = BABYLON.Vector3.Cross(x, BABYLON.Axis.Y);
      z.normalize();
      const y = BABYLON.Vector3.Cross(z, x).normalize();
      fromAxes(x, y, z, tracer.rotationQuaternion);
      tracer.position.copyFrom(from.add(dir.scale(0.5)));
      tracer.scaling.set(len, 0.085, 1);
      tracerMat.setFloat("uLife", 1);
      tracer.setEnabled(true);
      tracerLife = TRACER_DUR;
    }

    function impactBurst(point, normal) {
      sparkPos.copyFrom(point);
      sparkDir.copyFrom(normal.clone().normalize());
      sparks.manualEmitCount = 16;

      const ring = rings.find((r) => r.life <= 0) || rings[0];
      ring.life = ring.dur;
      ring.mesh.position.copyFrom(point.add(normal.scale(0.01)));
      ring.mesh.scaling.setAll(0.28);
      ring.mat.setFloat("uLife", 1);
      ring.mesh.setEnabled(true);
    }

    function update(dt) {
      if (flashLife > 0) {
        flashLife -= dt;
        const k = Math.max(flashLife / FLASH_DUR, 0);
        flashMat.setFloat("uLife", k * k);
        flash.scaling.setAll(0.5 + 0.6 * (1 - k));
        if (flashLife <= 0) flash.setEnabled(false);
      }
      if (tracerLife > 0) {
        tracerLife -= dt;
        tracerMat.setFloat("uLife", Math.max(tracerLife / TRACER_DUR, 0));
        if (tracerLife <= 0) tracer.setEnabled(false);
      }
      for (const r of rings) {
        if (r.life <= 0) continue;
        r.life -= dt;
        const k = Math.max(r.life / r.dur, 0);
        r.mat.setFloat("uLife", k);
        r.mesh.scaling.setAll(0.28 + 1.05 * (1 - k));
        if (r.life <= 0) r.mesh.setEnabled(false);
      }
    }

    return { muzzleFlash, shotTracer, impactBurst, update, alignZ, sparks };
  }

  window.createFx = create;
})();
