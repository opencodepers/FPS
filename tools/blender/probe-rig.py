"""Headless probe for the character + rifle GLBs.

Run:
  blender --background --python tools/blender/probe-rig.py

Prints the armature, the hand/foot bones in world space and the rifle's bounds
so the rifle can be fitted to the hand from real numbers instead of guesses.
"""
import bpy
from mathutils import Vector

CHAR = r"C:\Users\sophi\fps\game-ready\quaternius_mannequin.glb"
GUN = r"C:\Users\sophi\fps\game-ready\pirate_rifle.glb"


def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            p = obj.matrix_world @ Vector(corner)
            lo = Vector((min(lo[i], p[i]) for i in range(3)))
            hi = Vector((max(hi[i], p[i]) for i in range(3)))
    return lo, hi


clear()
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=CHAR)
char_objs = [o for o in bpy.data.objects if o not in before]
arms = [o for o in char_objs if o.type == "ARMATURE"]
print("\n=== CHARACTER")
print("objects:", len(char_objs), "armatures:", [a.name for a in arms])
lo, hi = world_bounds(char_objs)
print("bounds lo", tuple(round(v, 3) for v in lo), "hi", tuple(round(v, 3) for v in hi))
print("height", round(hi.z - lo.z, 3), "metres (Blender Z up)")

if arms:
    arm = arms[0]
    print("bones:", len(arm.data.bones))
    for name in ("DEF-hand.R", "DEF-hand.L", "DEF-hips", "DEF-foot.L", "DEF-toe.L", "root"):
        bone = arm.data.bones.get(name)
        if not bone:
            print("  missing bone", name)
            continue
        head = arm.matrix_world @ bone.head_local
        tail = arm.matrix_world @ bone.tail_local
        print("  %-11s head %s tail %s" % (name, tuple(round(v, 3) for v in head), tuple(round(v, 3) for v in tail)))
    foot = arm.data.bones.get("DEF-foot.L")
    toe = arm.data.bones.get("DEF-toe.L")
    if foot and toe:
        fwd = (arm.matrix_world @ toe.head_local) - (arm.matrix_world @ foot.head_local)
        fwd.z = 0
        fwd.normalize()
        print("  foot->toe (character forward):", tuple(round(v, 3) for v in fwd))

before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=GUN)
gun_objs = [o for o in bpy.data.objects if o not in before]
lo2, hi2 = world_bounds(gun_objs)
print("\n=== RIFLE")
print("objects:", [(o.name, o.type) for o in gun_objs if o.type != "MESH"])
print("bounds lo", tuple(round(v, 3) for v in lo2), "hi", tuple(round(v, 3) for v in hi2))
size = hi2 - lo2
print("size", tuple(round(v, 3) for v in size))
long_axis = max(range(3), key=lambda i: size[i])
print("long axis:", "XYZ"[long_axis])
for obj in gun_objs:
    if obj.type == "MESH":
        blo, bhi = world_bounds([obj])
        print("  %-32s center %s" % (obj.name, tuple(round((blo[i] + bhi[i]) / 2, 3) for i in range(3))))
