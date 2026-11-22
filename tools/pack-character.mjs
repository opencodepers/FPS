// Packs the Quaternius Universal Animation Library glTF (external .bin) into a
// single GLB, so the game can load the character exactly as authored (mesh,
// 53-bone Rigify skeleton and all 46 animations, no retargeting).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(ROOT, "tools", "anim-src", "quaternius", "AnimationLibrary.gltf");
const OUT = join(ROOT, "game-ready", "quaternius_mannequin.glb");

const json = JSON.parse(readFileSync(SRC, "utf8"));
const bin = readFileSync(join(dirname(SRC), json.buffers[0].uri));

// buffer 0 lives inside the GLB, so it must not carry a uri
json.buffers = [{ byteLength: bin.length }];
json.asset = { ...(json.asset || {}), generator: (json.asset && json.asset.generator) || "glTF packer" };

const jsonChunk = Buffer.from(JSON.stringify(json), "utf8");
const jsonPad = (4 - (jsonChunk.length % 4)) % 4;
const binPad = (4 - (bin.length % 4)) % 4;
const jsonLen = jsonChunk.length + jsonPad;
const binLen = bin.length + binPad;
const total = 12 + 8 + jsonLen + 8 + binLen;

const out = Buffer.alloc(total);
out.write("glTF", 0, "ascii");
out.writeUInt32LE(2, 4);
out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonLen, 12);
out.writeUInt32LE(0x4e4f534a, 16); // JSON
jsonChunk.copy(out, 20);
out.fill(0x20, 20 + jsonChunk.length, 20 + jsonLen);
out.writeUInt32LE(binLen, 20 + jsonLen);
out.writeUInt32LE(0x004e4942, 24 + jsonLen); // BIN
bin.copy(out, 28 + jsonLen);

writeFileSync(OUT, out);
console.log("wrote", OUT, (out.length / 1024 / 1024).toFixed(2) + " MB", "| animations", json.animations.length, "| joints", json.skins[0].joints.length);
