"""Leave character_rifle.blend showing the game's idle pose, not the aim pose.

fit_rifle.py fits the rifle at the aim pose, so the saved .blend used to open
frozen mid-aim. Hand-tuning is much easier against the pose the player actually
sees first, so this re-opens the file with the idle action and saves it.

  "/c/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background \
    --factory-startup game-ready/character_rifle.blend \
    --python tools/blender/reset_pose.py
"""
import bpy

arm = next((o for o in bpy.data.objects if o.type == "ARMATURE"), None)
if arm is None:
    raise RuntimeError("no armature in the blend")

ad = arm.animation_data or arm.animation_data_create()
for track in ad.nla_tracks:
    track.mute = True

idle = next((a for a in bpy.data.actions if "idle" in a.name.lower()), None)
if idle is not None:
    ad.action = idle
    try:
        if idle.slots:
            ad.action_slot = idle.slots[0]
    except Exception:
        pass

bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()
print("POSE_REPORT " + (idle.name if idle else "rest"))
bpy.ops.wm.save_mainfile()
