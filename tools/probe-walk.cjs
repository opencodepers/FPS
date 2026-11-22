// Probe: does a clip actually move the bones, and how far does the foot travel?
const fs = require("fs"), vm = require("vm");
global.window = global;
global.navigator = { userAgent: "node" };
global.document = {
  createElement() { return { getContext() { return null; }, style: {}, addEventListener() {}, removeEventListener() {} }; },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: {} }, body: { appendChild() {} },
  getElementById() { return null; }, pointerLockElement: null,
};
global.require = (id) => (id === "babylonjs" ? global.BABYLON : undefined);
global.location = { protocol: "http:" };
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
global.URL = { createObjectURL: () => "blob:x", revokeObjectURL() {} };
global.performance = global.performance || { now: () => Date.now() };

(async () => {
  vm.runInThisContext(fs.readFileSync("vendor/babylon.js", "utf8"));
  vm.runInThisContext(fs.readFileSync("vendor/babylon.glTF2FileLoader.js", "utf8"));
  const B = global.BABYLON;
  const engine = new B.NullEngine();
  engine.getDeltaTime = () => 1000 / 60;
  const scene = new B.Scene(engine);
  const camera = new B.FreeCamera("cam", new B.Vector3(0, 2, 6), scene);
  camera.inputs.clear();
  const url = "data:model/gltf-binary;base64," + fs.readFileSync("game-ready/quaternius_mannequin.glb").toString("base64");
  const r = await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const skinned = r.meshes.find((m) => m.skeleton);
  const skel = skinned.skeleton;
  const bone = (n) => skel.bones.find((b) => b.name === n);
  const foot = bone("DEF-foot.L"), thigh = bone("DEF-thigh.L");

  for (const name of ["Walk_Loop", "Jog_Fwd_Loop", "Sprint_Loop"]) {
    const g = scene.animationGroups.find((x) => x.name === name);
    if (!g) { console.log(name + ": missing"); continue; }
    for (const other of scene.animationGroups) { other.stop(); other.weight = 0; }
    g.start(true, 1, g.from, g.to, false);
    g.weight = 1;
    g.speedRatio = 1;
    const cycle = (g.to - g.from) / (g.targetedAnimations[0].animation.framePerSecond || 24);
    const f0 = foot.getAbsolutePosition().clone();
    let minZ = Infinity, maxZ = -Infinity, moved = 0;
    for (let f = 0; f < 220; f++) {
      scene.render();
      const p = foot.getAbsolutePosition();
      const t = thigh.getAbsolutePosition();
      if (f % 40 === 0) console.log("  f" + f + " foot " + p.x.toFixed(3) + "," + p.y.toFixed(3) + "," + p.z.toFixed(3) + " thigh " + t.y.toFixed(3));
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      if (B.Vector3.Distance(p, f0) > 0.001) moved++;
    }
    console.log(name + ": cycle " + cycle.toFixed(2) + "s | z span " + (maxZ - minZ).toFixed(3) +
      " | frames moved " + moved + "/220 | natural " + ((maxZ - minZ) / cycle).toFixed(2) + " m/s");
  }
})().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
