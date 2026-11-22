// Checks the two animation layers do not target the same bones: the rifle hold
// must own the arms, the locomotion slices must own the legs.
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
  vm.runInThisContext(fs.readFileSync("js/animations.js", "utf8"));
  const B = global.BABYLON;
  const scene = new B.Scene(new B.NullEngine());
  const camera = new B.FreeCamera("cam", new B.Vector3(0, 2, 6), scene);
  camera.inputs.clear();
  const url = "data:model/gltf-binary;base64," + fs.readFileSync("game-ready/quaternius_mannequin.glb").toString("base64");
  await B.SceneLoader.ImportMeshAsync(null, "", url, scene, null, ".glb");
  const animator = global.createAnimator(scene);

  const names = (g) => new Set(g.targetedAnimations.map((ta) => (ta.target && ta.target.name) || "").filter(Boolean));
  const hold = animator.hold;
  const holdNames = hold ? names(hold) : new Set();
  const legNames = new Set();
  for (const key of ["idle", "walk", "jog", "sprint", "jump", "land"]) {
    const g = animator.groups[key];
    if (g) for (const n of names(g)) legNames.add(n);
  }
  const overlap = [...holdNames].filter((n) => legNames.has(n));
  console.log("holdUpper targets:", holdNames.size, "bones ->", [...holdNames].sort().join(", "));
  console.log("locomotion targets:", legNames.size, "bones ->", [...legNames].sort().join(", "));
  console.log("overlap:", overlap.length, overlap.join(", "));
  const wants = ["DEF-hand.R", "DEF-hand.L", "DEF-forearm.R", "DEF-upper_arm.L"];
  console.log("hold has:", wants.map((n) => n + "=" + holdNames.has(n)).join(" "));
  const legs = ["DEF-thigh.L", "DEF-shin.L", "DEF-foot.L", "DEF-toe.L"];
  console.log("legs have:", legs.map((n) => n + "=" + legNames.has(n)).join(" "));
  console.log("hold playing:", hold && hold.isPlaying, "weight", hold && hold.weight);
  process.exit(overlap.length === 0 ? 0 : 1);
})().catch((e) => { console.log("FAILED:", e.message); process.exit(1); });
