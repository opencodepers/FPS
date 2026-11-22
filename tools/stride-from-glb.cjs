// Reads the mannequin GLB directly and composes the joint chain over each clip
// to get the real stride, without relying on Babylon's animation clock.
const fs = require("fs");

const glb = fs.readFileSync("game-ready/quaternius_mannequin.glb");
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString("utf8"));
const binStart = 20 + jsonLen + 8;
const bin = glb.slice(binStart);

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessor(i) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const comps = COMP[a.type];
  const n = a.count * comps;
  const out = new Float64Array(n);
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  for (let k = 0; k < n; k++) out[k] = bin.readFloatLE(base + k * 4);
  return { values: out, comps, count: a.count };
}

const nodeIndex = (name) => json.nodes.findIndex((n) => n.name === name);

// ---- 4x4 matrices, row-major, row-vector convention (v * M)
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
};
const trs = (t, q, s) => {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
};
const localMatrix = (node) =>
  node.matrix ? node.matrix.slice() : trs(node.translation || [0, 0, 0], node.rotation || [0, 0, 0, 1], node.scaling || [1, 1, 1]);

const parents = new Array(json.nodes.length).fill(-1);
json.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parents[c] = i)));

function worldOf(nodeIdx, pose) {
  let m = pose[nodeIdx] || localMatrix(json.nodes[nodeIdx]);
  let p = parents[nodeIdx];
  while (p >= 0) {
    m = mul(m, pose[p] || localMatrix(json.nodes[p]));
    p = parents[p];
  }
  return m;
}

function sample(anim, time) {
  const pose = {};
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = accessor(s.input).values;
    const vals = accessor(s.output);
    let i = 0;
    while (i < times.length - 1 && times[i + 1] < time) i++;
    const t0 = times[i], t1 = times[Math.min(i + 1, times.length - 1)];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
    const c = vals.comps;
    const out = [];
    for (let k = 0; k < c; k++) {
      const a = vals.values[i * c + k];
      const b = vals.values[Math.min(i + 1, vals.count - 1) * c + k];
      out.push(a + (b - a) * f);
    }
    const node = ch.target.node;
    pose[node] = pose[node] || localMatrix(json.nodes[node]);
    const m = pose[node];
    if (ch.target.path === "translation") { m[12] = out[0]; m[13] = out[1]; m[14] = out[2]; }
    else if (ch.target.path === "rotation") {
      const [x, y, z, w] = out;
      const t = trs([m[12], m[13], m[14]], [x, y, z, w], [1, 1, 1]);
      for (let k = 0; k < 12; k++) m[k] = t[k];
    } else if (ch.target.path === "scale") {
      const base = localMatrix(json.nodes[node]);
      const t = trs([m[12], m[13], m[14]], [0, 0, 0, 1], out);
      for (let k = 0; k < 12; k++) m[k] = t[k] * (base[k] || 1) / (base[k] || 1);
      // scale is baked by rebuilding from the rest rotation below
      const rest = json.nodes[node];
      const rot = rest.rotation || [0, 0, 0, 1];
      const rebuilt = trs([m[12], m[13], m[14]], rot, out);
      for (let k = 0; k < 12; k++) m[k] = rebuilt[k];
    }
  }
  return pose;
}

const footIdx = nodeIndex("DEF-foot.L");
const heelIdx = nodeIndex("DEF-toe.L");
for (const name of ["Walk_Loop", "Walk_Formal_Loop", "Jog_Fwd_Loop", "Sprint_Loop"]) {
  const anim = json.animations.find((a) => a.name === name);
  if (!anim) { console.log(name + ": missing"); continue; }
  const end = Math.max(...anim.samplers.map((s) => accessor(s.input).values[accessor(s.input).count - 1]));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * end;
    const pose = sample(anim, t);
    const w = worldOf(footIdx, pose);
    const x = w[12], y = w[13], z = w[14];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); minY = Math.min(minY, y);
  }
  // Horizontal spread of the ankle over the cycle, whichever axis the rig
  // actually strides along.
  const stride = Math.max(maxX - minX, maxZ - minZ);
  console.log(name + ": " + end.toFixed(2) + "s | foot x " + minX.toFixed(3) + ".." + maxX.toFixed(3) +
    " z " + minZ.toFixed(3) + ".." + maxZ.toFixed(3) +
    " | stride " + stride.toFixed(3) + " m | natural " + (stride / end).toFixed(2) + " m/s | lowest y " + minY.toFixed(3));
}
