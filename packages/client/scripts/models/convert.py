"""
Converts the period figures and buildings into the GLBs the game loads. Run by
Blender, which `convert.ts` finds:

  blender -b --factory-startup --python convert.py -- <sources> <out> [name...]

`sources` is the folder the packs were unzipped into and `out` the game's models;
naming figures or buildings converts only those. Each figure is posed and animated
from its body's set, given its texture, made matte, shrunk to TEXTURE pixels,
scaled by SCALE and written with its animation stepped at FPS, under `units/`. Each
building is cut out of its scene and stood at a man to the unit, under
`buildings/`.
"""
import json
import os
import shutil
import struct
import sys
import tempfile

import bpy

# The figure scripts beside this one are imported, and nothing should be left behind in
# the repo for having been.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(__file__))
import building  # noqa: E402
import flag  # noqa: E402
import foot  # noqa: E402
import gun  # noqa: E402
import mounted  # noqa: E402
from rig import Rig, join  # noqa: E402

# One factor for every figure: the packs share a scale, so men, horses and the gun
# keep their proportions, and a man on foot comes out about one unit tall.
SCALE = 0.25
TEXTURE = 256
FPS = 12

FOOT_UK, FOOT_US = 'itch_io_1776_EXPORT/FOOT/UK', 'itch_io_1776_EXPORT/FOOT/USA'
QUAD = 'itch_io_1776_EXPORT_2/QUAD'

HUSSAR = 'itch_io_horse_XIIX_c/hussar_American'
RANGERS = 'itch_io_1776_EXPORT/QUAD/Queensranger'

# Where a figure that lacks a sabre gets one: this trooper's, its own piece cut away.
SABRE_DONOR = f'{QUAD}/Mawhood/britCav.glb'
WEAPON = 'ammo node 0'


def british_general(armature, mesh, sources):
    # The Queen's Rangers' officer holds no sabre, only a small piece where the
    # cavalry hold one.
    give_sabre(armature, mesh, os.path.join(sources, SABRE_DONOR))
    flag.carry_flag(armature, mesh, flag.kings)


def continental_general(armature, mesh, sources):
    flag.carry_flag(armature, mesh, flag.washingtons)


# out path, source, a texture the source left beside it, body, and anything the
# figure is given before it is posed.
FIGURES = [
    ('british/infantry', f'{FOOT_UK}/musket_Redcoat.glb', None, foot.infantry, None),
    ('continental/infantry', f'{FOOT_US}/musket_USA.glb', None, foot.infantry, None),
    ('british/gunner', f'{FOOT_UK}/musket_Redcoatgunner.glb', None, foot.gunner, None),
    ('continental/gunner', f'{FOOT_US}/musket-gunner.glb', None, foot.gunner, None),
    ('british/crew', f'{FOOT_UK}/musket_Redcoat-unarmed.glb', None, foot.crew, None),
    ('continental/crew', f'{FOOT_US}/musket_USA-unarmed.glb', None, foot.crew, None),
    ('british/cavalry', f'{QUAD}/Mawhood/britCav.glb', None, mounted.cavalry, None),
    ('continental/cavalry', f'{QUAD}/Cont1Drag/1contdrag-melee.glb', None, mounted.cavalry, None),
    # The rider without the carbine its twin carries; a grey horse sets it apart.
    ('british/general', f'{RANGERS}/horse_queenRanger.glb', f'{RANGERS}/queenranger.png', mounted.cavalry, british_general),
    ('continental/general', f'{HUSSAR}/chevauleger_USA.glb', f'{HUSSAR}/hussar_american.png', mounted.cavalry, continental_general),
    ('gun', 'itch_io_1776_EXPORT/tabor/falconet.glb', 'itch_io_1776_EXPORT/tabor/tabor.png', gun.falconet, None),
]


PICKETS = 'ITCH_io_rifle_ACW/pickets'
TOWN = 'itch_io_town/scenery_itch_town.blend'
HARBOUR = 'itch_io_bavharbor/bavarian_harbor/scenery_itch_harbor.blend'
# How tall a man is in the town and the harbour, which share a scale: the supply
# wagon they both carry is three men long in the figures' pack.
TOWN_MAN = 0.4

# out name, source, the object it is in its scene, how tall a man is there, and the
# quarter turns that bring its door round to -Y. The pickets' houses each have their
# own scale, taken from the copy of the same house in the town.
BUILDINGS = [
    ('house_cottage', f'{PICKETS}/galician/galician_single1.blend', 'door', 0.563, 1),
    ('house_timbered', f'{PICKETS}/galician_2a/galician_2a.blend', 'doorframe', 0.516, 0),
    ('house_slate', f'{PICKETS}/chalet_celtic/galician_2b_single.blend', 'Object01', 0.616, 0),
    ('house_narrow', f'{PICKETS}/keisha_single/keisha_single.blend', 'keisha_single', TOWN_MAN, 1),
    ('house_dutch', TOWN, 'boards', TOWN_MAN, 3),
    ('house_villa', HARBOUR, 'rep 1', TOWN_MAN, 1),
]


def main():
    args = sys.argv[sys.argv.index('--') + 1:]
    sources, out, only = args[0], args[1], set(args[2:])
    scratch = tempfile.mkdtemp(prefix='figures-')
    try:
        # A scratch folder each: the images packed back are named by how many the
        # folder already holds, and a model converted alongside others would
        # otherwise come out different from the same model converted alone.
        for name, source, texture, body, dress in FIGURES:
            if only and name not in only:
                continue
            convert(sources, out, tempfile.mkdtemp(dir=scratch), name, source, texture, body, dress)
        for name, source, root, man, turns in BUILDINGS:
            if only and name not in only:
                continue
            convert_building(sources, out, tempfile.mkdtemp(dir=scratch), name, source, root, man, turns)
    finally:
        shutil.rmtree(scratch)


def convert_building(sources, out, scratch, name, source, root, man, turns):
    pack = os.path.join(sources, source.split('/')[0])
    house = building.join(building.load(os.path.join(sources, source), root, pack))
    building.stand(house, man, turns)
    building.repaint(house, name)
    finish_materials(None, scratch)
    path = os.path.join(out, 'buildings', f'{name}.glb')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', export_apply=True, export_animations=False)
    faces = sum(len(p.vertices) - 2 for p in house.data.polygons)
    print(f'CONVERTED {name}: {faces} triangles -> {os.path.getsize(path) // 1024} KB')


def convert(sources, out, scratch, name, source, texture, body, dress):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    armature, mesh = load(os.path.join(sources, source))
    if dress:
        dress(armature, mesh, sources)
    finish_materials(os.path.join(sources, texture) if texture else None, scratch)

    rig = Rig(armature, mesh)
    actions = body.actions(rig)
    for action, keys in actions.items():
        rig.key(action, keys)

    armature.scale = (SCALE, SCALE, SCALE)
    bpy.context.scene.render.fps = FPS
    path = os.path.join(out, 'units', f'{name}.glb')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_animation_mode='NLA_TRACKS',
        export_force_sampling=True,
        export_frame_step=1,
    )
    step_animation(path)
    print(f'CONVERTED {name}: {", ".join(actions)} -> {os.path.getsize(path) // 1024} KB')


def load(path):
    """The source's armature and skinned mesh -- and nothing else, the importer's bone
    shape included."""
    bpy.ops.import_scene.gltf(filepath=path)
    armature = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    mesh = next(o for o in bpy.data.objects if o.type == 'MESH' and o.parent == armature)
    for o in list(bpy.data.objects):
        if o not in (armature, mesh):
            bpy.data.objects.remove(o)
    return armature, mesh


def give_sabre(armature, mesh, donor_path):
    """Cut away what the hand holds, and put the donor's sabre in it, skinned to the
    same bone and placed as far from the hand as the donor's was, in the donor's own
    material."""
    cut(mesh, keep=lambda group: group != WEAPON)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=donor_path)
    donor_arm = next(o for o in set(bpy.data.objects) - before if o.type == 'ARMATURE')
    donor = next(o for o in set(bpy.data.objects) - before if o.type == 'MESH' and o.parent == donor_arm)
    cut(donor, keep=lambda group: group == WEAPON)

    hand = 'dwristrigh'
    offset = armature.data.bones[hand].head_local - donor_arm.data.bones[hand].head_local
    for v in donor.data.vertices:
        v.co += offset
    for o in set(bpy.data.objects) - before:
        if o is not donor:
            bpy.data.objects.remove(o)
    # Painted as the donor painted it, from its own atlas: the figure's paints a
    # different picture where the sabre's faces point.
    join(armature, mesh, donor)


def cut(mesh, keep):
    """Delete every vertex whose strongest weight is to a group `keep` refuses."""
    names = {g.index: g.name for g in mesh.vertex_groups}
    doomed = [
        v.index for v in mesh.data.vertices
        if v.groups and not keep(names[max(v.groups, key=lambda e: e.weight).group])
    ]
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(mesh.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in doomed], context='VERTS')
    bm.to_mesh(mesh.data)
    bm.free()


def finish_materials(texture, scratch):
    """Every material matte, the loose texture on any that has none, and every image
    shrunk and packed back.

    Matte because several sources leave the metallic factor at glTF's default of
    one, which draws black under a light with no environment to reflect."""
    loose = bpy.data.images.load(texture) if texture else None
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        nodes = material.node_tree.nodes
        bsdf = next((n for n in nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 1.0
        if loose and not bsdf.inputs['Base Color'].is_linked:
            node = nodes.new('ShaderNodeTexImage')
            node.image = loose
            material.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
    # ⚠️ Replaced rather than scaled in place: an image the importer packed is
    # exported from its packed bytes, whatever its pixels became.
    for image in list(bpy.data.images):
        if not image.users or image.size[0] == 0:
            continue
        if image.size[0] > TEXTURE or image.size[1] > TEXTURE:
            image.scale(TEXTURE, TEXTURE)
        width, height = image.size
        small = bpy.data.images.new(f'{image.name}-small', width, height, alpha=True)
        small.pixels.foreach_set(image.pixels[:])
        path = os.path.join(scratch, f'{len(os.listdir(scratch))}.png')
        small.filepath_raw = path
        small.file_format = 'PNG'
        small.save()
        packed = bpy.data.images.load(path)
        packed.pack()
        packed.name = image.name
        image.user_remap(packed)
        bpy.data.images.remove(small)
        bpy.data.images.remove(image)


def step_animation(path):
    """Marks every animation sampler STEP, so the figure moves pose to pose at FPS --
    the exporter writes them LINEAR however the keys were made."""
    with open(path, 'rb') as f:
        data = f.read()
    json_length = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + json_length])
    for animation in gltf.get('animations', []):
        for sampler in animation['samplers']:
            sampler['interpolation'] = 'STEP'
    chunk = json.dumps(gltf, separators=(',', ':')).encode()
    chunk += b' ' * (-len(chunk) % 4)
    rest = data[20 + json_length:]
    header = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(chunk) + len(rest))
    with open(path, 'wb') as f:
        f.write(header + struct.pack('<II', len(chunk), 0x4E4F534A) + chunk + rest)


main()
