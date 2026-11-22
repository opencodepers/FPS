"""Import character + rifle, put the rifle in the right hand at the aim pose,
parent it to the hand bone and export one GLB.

Sent to Blender through tools/blender/send.py (execute_code).
"""
import json
import os

import bpy
from mathutils import Matrix, Vector

CHAR = r"C:\Users\sophi\fps\game-ready\quaternius_mannequin.glb"
GUN = r"C:\Users\sophi\fps\game-ready\pirate_rifle.glb"
OUT = r"C:\Users\sophi\fps\game-ready\character_rifle.glb"
BLEND = r"C:\Users\sophi\fps\game-ready\character_rifle.blend"

report = {}


def bounds(objs):
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


def center(obj):
    lo, hi = bounds([obj])
    return (lo + hi) / 2


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=CHAR)
armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not armatures:
    raise RuntimeError("no armature in the character glb")
arm = armatures[0]
report["armature"] = arm.name

# ---------------------------------------------------------------- aim pose
names = [a.name for a in bpy.data.actions]
report["actions"] = len(names)
aim = next((a for a in bpy.data.actions if "Aim" in a.name and "Neutral" in a.name), None)
report["aim_action"] = aim.name if aim else None
if aim:
    ad = arm.animation_data or arm.animation_data_create()
    for track in ad.nla_tracks:
        track.mute = True
    ad.action = aim
    try:
        if aim.slots:
            ad.action_slot = aim.slots[0]
    except Exception as exc:  # noqa: BLE001 - slot API differs per version
        report["slot_error"] = str(exc)
    start, end = aim.frame_range
    frame = int(start + (end - start) * 0.5)
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    report["frame"] = frame

bone = arm.pose.bones.get("DEF-hand.R")
if bone is None:
    raise RuntimeError("DEF-hand.R not found")
hand_world = arm.matrix_world @ bone.head
report["hand_world"] = [round(v, 4) for v in hand_world]

# ---------------------------------------------------------------- rifle
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=GUN)
new = [o for o in bpy.data.objects if o not in before]
roots = [o for o in new if o.parent is None]
meshes = [o for o in new if o.type == "MESH"]
if not roots or not meshes:
    raise RuntimeError("rifle import produced no roots/meshes")
# a single parent keeps the whole gun rigid
if len(roots) > 1:
    holder = bpy.data.objects.new("Rifle", None)
    bpy.context.collection.objects.link(holder)
    for root in roots:
        root.parent = holder
    roots = [holder]
rifle = roots[0]
# Gameplay size: the source is 1.358 m long, which reads as a cannon on a
# 1.8 m character; 0.72 gives a 0.98 m rifle.
RIFLE_SCALE = 0.72
# Multiply, never assign: the Sketchfab root already carries a 0.01 scale.
rifle.scale = tuple(s * RIFLE_SCALE for s in rifle.scale)
bpy.context.view_layer.update()
report["rifle_roots"] = [o.name for o in roots]
report["rifle_scale"] = RIFLE_SCALE

body = next((m for m in meshes if "Body 2" in m.name), None) or meshes[0]
barrel = next((m for m in meshes if "Barrel" in m.name and "Scope" not in m.name), None)
report["rifle_size"] = [round(v, 3) for v in (lambda b: b[1] - b[0])(bounds(meshes))]

# Grip goes in the palm: body centre is the grip area, 5 cm past the wrist.
grip = center(body)
target = hand_world + Vector((0.0, 0.0, 0.0))
delta = target - grip
rifle.location += delta
bpy.context.view_layer.update()
report["grip_to_hand"] = round((hand_world - center(body)).length, 4)
lo2, hi2 = bounds(meshes)
report["rifle_bounds_after"] = [round(v, 3) for v in lo2] + [round(v, 3) for v in hi2]

# ---------------------------------------------------------------- skin to hand
# Bone-parented meshes do not follow the skeleton outside Blender: Babylon's
# glTF loader turns them into a STATIC copy of the joint node (measured: the
# rifle did not move between animation frames). Skinning the rifle 100% to
# DEF-hand.R makes every engine follow the hand for free.
#
# Bind at the REST pose: the rifle already sits in the palm as posed above, so
# the rest-pose deform is identity and the aim pose lands it exactly there.
# The hand frame at the AIM pose (where the rifle was fitted) and the rifle's
# placement inside it. The skin binds against the REST skeleton, so the rifle is
# re-hung in the rest hand's frame: the aim pose then returns it to the palm,
# and between poses it swings rigidly with the wrist.
aim_hand = arm.matrix_world @ bone.matrix
grip_in_hand = aim_hand.inverted() @ rifle.matrix_world

ad = arm.animation_data
if ad:
    ad.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
rest_hand = arm.matrix_world @ bone.matrix
rifle.matrix_world = rest_hand @ grip_in_hand
bpy.context.view_layer.update()

# ------------------------------------------------------- forearm clearance
# The rifle is rigid in the hand, so a shift written in the rest hand's frame
# holds in every pose. In the arms-down poses the stock sat inside the forearm;
# find the smallest hand-frame nudge that lifts the rifle out of the forearm
# capsule and fold it into grip_in_hand, so aim and locomotion both use it.
# Manual override, in the rest hand's local axes (metres), applied to the rifle
# before it is skinned. None = auto-solve the smallest shift that lifts the rifle
# out of the forearm capsule (that is what the last bake used: 8 cm along -Y).
# Set a tuple such as (0.0, -0.03, 0.02) to place the rifle by hand instead.
RIFLE_NUDGE = None

ELBOW = arm.matrix_world @ bone.parent.head
WRIST = rest_hand.translation
FOREARM_R = 0.055


def seg_dist(p, a, b):
    ab = b - a
    t = 0.0 if ab.length_squared == 0 else max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


pts = [m.matrix_world @ m.data.vertices[i].co for m in meshes for i in range(0, len(m.data.vertices), 7)]


def clearance(shift):
    return min(seg_dist(p + shift, ELBOW, WRIST) for p in pts) - FOREARM_R


axes = []
for i in range(3):
    axis = rest_hand.to_3x3() @ Vector(tuple(1.0 if i == j else 0.0 for j in range(3)))
    axes += [axis, -axis]
base_clear = clearance(Vector((0.0, 0.0, 0.0)))
best_shift = Vector((0.0, 0.0, 0.0))
best_step = 1.0
if RIFLE_NUDGE is not None:
    best_shift = Vector(RIFLE_NUDGE)
    best_step = 0.0
else:
    for axis in axes:
        for step in [0.01 * n for n in range(1, 9)]:
            if clearance(axis * step) >= 0.012:
                if step < best_step:
                    best_step = step
                    best_shift = axis * step
                break
    if best_step > 1.0:  # nothing cleared the arm: take the least bad nudge
        best_shift = max(axes, key=lambda ax: clearance(ax * 0.05)) * 0.05
rifle.matrix_world = Matrix.Translation(best_shift) @ rifle.matrix_world
grip_in_hand = rest_hand.inverted() @ rifle.matrix_world
bpy.context.view_layer.update()
report["forearm_clearance"] = [round(base_clear, 4), round(clearance(best_shift), 4)]
report["rifle_shift"] = [round(v, 3) for v in best_shift]
report["rest_hand"] = [round(v, 3) for v in (arm.matrix_world @ bone.head)]
report["grip_offset_in_hand"] = round((rifle.matrix_world.translation - (aim_hand.translation)).length, 4)

for m in meshes:
    world = m.matrix_world.copy()
    m.parent = arm
    m.parent_type = "OBJECT"
    m.matrix_parent_inverse = arm.matrix_world.inverted()
    m.matrix_world = world
    vg = m.vertex_groups.get("DEF-hand.R") or m.vertex_groups.new(name="DEF-hand.R")
    vg.add(list(range(len(m.data.vertices))), 1.0, "REPLACE")
    if not any(mod.type == "ARMATURE" for mod in m.modifiers):
        mod = m.modifiers.new("Armature", "ARMATURE")
        mod.object = arm
bpy.context.view_layer.update()
report["skin"] = "DEF-hand.R"
report["moved_after_skin"] = round((center(body) - hand_world).length, 4)

# ------------------------------------------------------------- aim-run clip
# The aim-run torso twist belongs in the animation, not in the engine: an extra
# AnimationGroup added at runtime was ignored by the engine, so the twist is
# baked here as a looping clip that is the aim pose plus one stride of waist and
# head movement. The legs are untouched - their own locomotion clips drive them.
import math
from mathutils import Quaternion

RUN_FRAMES = 18  # one stride cycle; 18 frames at 24 fps = 0.75 s
if aim is None:
    report["aim_run"] = "skipped: no aim action"
else:
    ad = arm.animation_data or arm.animation_data_create()
    for t in ad.nla_tracks:
        t.mute = True
    ad.action = aim
    try:
        if aim.slots:
            ad.action_slot = aim.slots[0]
    except Exception:  # noqa: BLE001 - slot API differs per version
        pass
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()

    sway_bones = [b for b in (arm.pose.bones.get(n) for n in
                              ("DEF-spine.002", "DEF-spine.003", "DEF-neck", "DEF-head")) if b]
    base = {b.name: b.rotation_quaternion.copy() for b in sway_bones}

    run = aim.copy()
    run.name = "Aim_Run_Loop"
    run.use_fake_user = True
    ad.action = run
    try:
        if run.slots:
            ad.action_slot = run.slots[0]
    except Exception:  # noqa: BLE001 - slot API differs per version
        pass

    # (bob about X, twist about the bone's own axis, side bend about Z) radians
    # Side bend is ZERO on purpose: bending the waist left and right read as
    # "swaying". A real aim-run rotates the ribcage about the spine instead, so
    # one shoulder drives forward while the other pulls back (twist, about the
    # bone's own axis) - the neck and head partly counter it so the head stays
    # pointed down the sights.
    CURVE = {
        "DEF-spine.002": (0.030, 0.300, 0.0),
        "DEF-spine.003": (0.020, 0.150, 0.0),
        "DEF-neck": (0.015, -0.180, 0.0),
        "DEF-head": (0.010, -0.080, 0.0),
    }

    SWAY_SCALE = 0.60
    CURVE = {k: tuple(v * SWAY_SCALE for v in vals) for k, vals in CURVE.items()}
    # The hips turn with the shoulders too, just less - otherwise the torso
    # twists over a pair of frozen buttocks, which is what it looked like.
    pelvis = next((b for b in arm.pose.bones if "pelvis" in b.name.lower() or "hips" in b.name.lower()), None)
    if pelvis:
        sway_bones.append(pelvis)
        CURVE[pelvis.name] = (0.012, 0.100, 0.0)
        base[pelvis.name] = pelvis.rotation_quaternion.copy()

    for f in range(RUN_FRAMES + 1):
        p = (f / RUN_FRAMES) * math.tau
        for b in sway_bones:
            bob, twist, bend = CURVE[b.name]
            q = Quaternion((1.0, 0.0, 0.0), math.sin(p * 2) * bob)
            q = q @ Quaternion((0.0, 1.0, 0.0), math.sin(p) * twist)
            q = q @ Quaternion((0.0, 0.0, 1.0), -math.cos(p) * bend)
            b.rotation_quaternion = base[b.name] @ q
            b.keyframe_insert("rotation_quaternion", frame=f, group=b.name)

    # Measured proof the bake moves the upper body: the head's world position at
    # four points of the cycle. Sideways (X) travel is the waist twist.
    shoulders = [b for b in (arm.pose.bones.get(n) for n in ("DEF-shoulder.L", "DEF-shoulder.R")) if b]
    probe_sh = []
    probe = []
    for f in (0, RUN_FRAMES // 4, RUN_FRAMES // 2, (3 * RUN_FRAMES) // 4):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        head = arm.pose.bones.get("DEF-head")
        probe.append([round(v, 4) for v in (arm.matrix_world @ head.head)])
        probe_sh.append([round((arm.matrix_world @ b.head).y, 4) for b in shoulders])
    report["aim_run"] = {
        "name": run.name,
        "frames": RUN_FRAMES,
        "bones": [b.name for b in sway_bones],
        "head_probe": probe,
        "head_x_spread": round(max(p[0] for p in probe) - min(p[0] for p in probe), 4),
        "shoulder_y_swing": [round(max(p[i] for p in probe_sh) - min(p[i] for p in probe_sh), 4) for i in range(len(shoulders))],
    }
    ad.action = None

# ---------------------------------------------------------------- save + export
# Leave the scene on the idle clip, not the aim pose used for fitting: the .blend
# is opened by hand to nudge the rifle, and the player's default pose is far
# easier to judge against than a frozen aim frame.
idle_action = next((a for a in bpy.data.actions if a.name == "Idle_Loop"), None)
if arm.animation_data and idle_action:
    for track in arm.animation_data.nla_tracks:
        track.mute = True
    arm.animation_data.action = idle_action
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
report["blend_pose"] = idle_action.name if idle_action else "aim"
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
# The engine replaces the rifle's 18 textures with flat colours, so the export
# carries geometry only and stays small.
for img in list(bpy.data.images):
    if img.users == 0 or img.name not in {"Render Result", "Viewer Node"}:
        try:
            bpy.data.images.remove(img)
        except Exception:
            pass
try:
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_apply=False,
        export_image_format="NONE",
    )
except TypeError:
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        use_selection=False,
        export_animations=True,
        export_apply=False,
    )
report["glb_bytes"] = os.path.getsize(OUT) if os.path.exists(OUT) else 0
report["blend_bytes"] = os.path.getsize(BLEND) if os.path.exists(BLEND) else 0

report["rifle_meshes"] = len(meshes)
print("FIT_REPORT " + json.dumps(report))
