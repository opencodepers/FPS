"""Export game-ready/character_rifle.blend to the game GLB.

Use after nudging the rifle by hand in the saved .blend, instead of re-running
fit_rifle.py (which rebuilds the fit from the source GLBs and would throw the
hand placement away):

  "/c/Program Files/Blender Foundation/Blender 5.3/blender.exe" --background \
    --factory-startup game-ready/character_rifle.blend \
    --python tools/blender/export_blend.py

Export options match fit_rifle.py (no image data, no modifiers applied) so the
engine keeps getting the same shape of file.
"""
import json
import os

import bpy

OUT = r"C:\Users\sophi\fps\game-ready\character_rifle.glb"

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

print("EXPORT_OK " + json.dumps({
    "bytes": os.path.getsize(OUT) if os.path.exists(OUT) else 0,
    "actions": len(bpy.data.actions),
}))
