"""
A building, out of the scene it was modelled in: the one object and whatever hangs
from it, its modifiers applied and its parts joined, standing on its own base at the
origin with its door turned to -Y, at a man to the unit, and painted with its base
colour alone -- the packs' normal and specular maps go, as the figures' do.
"""
import os

import bpy

# Image names that are not a colour, for a material that never says which one is.
NOT_COLOUR = ('norm', 'nrm', 'spec', 'bump', 'rough', 'gloss')


def load(path, root, pack):
    bpy.ops.wm.open_mainfile(filepath=path)
    top = bpy.data.objects[root]
    keep = {top, *top.children_recursive}
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o)
    relink(pack)
    return [o for o in keep if o.type == 'MESH']


def relink(pack):
    """Points every image at its file in the pack: the scenes name their authors' own
    folders, and some name a file in another case or with another extension."""
    found = {}
    for folder, _, files in os.walk(pack):
        for f in files:
            found.setdefault(f.lower(), os.path.join(folder, f))
    for image in bpy.data.images:
        # ⚠️ Its size, never `has_data`, which stays false until something reads
        # the pixels -- and reading the size is what loads them.
        if image.source != 'FILE' or image.size[0]:
            continue
        name = os.path.basename(image.filepath.replace('\\', '/')).lower()
        stem = os.path.splitext(name)[0]
        for candidate in [name] + [stem + ext for ext in ('.png', '.tga', '.jpg')]:
            if candidate in found:
                image.filepath = found[candidate]
                image.reload()
                if image.size[0]:
                    break


def join(meshes):
    """One object, modifiers applied and every transform baked in."""
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.make_single_user(object=True, obdata=True)
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    building = bpy.context.view_layer.objects.active
    for o in list(bpy.data.objects):
        if o is not building:
            bpy.data.objects.remove(o)
    return building


def stand(building, man, turns):
    """On its base at the origin, its door to -Y, a man tall to the unit."""
    corners = [building.matrix_world @ v.co for v in building.data.vertices]
    low = [min(c[i] for c in corners) for i in range(3)]
    high = [max(c[i] for c in corners) for i in range(3)]
    building.location = (-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, -low[2])
    bpy.ops.object.transform_apply(location=True)
    building.rotation_euler = (0, 0, turns * 3.14159265358979 / 2)
    building.scale = (1 / man,) * 3
    bpy.ops.object.transform_apply(rotation=True, scale=True)


def colour_of(material):
    """The image a material is coloured by: whatever feeds a shader's colour, or failing
    that the first image that is not a map of something else."""
    tree = material.node_tree
    if not tree:
        return None

    def upstream(socket):
        for link in socket.links:
            yield link.from_node
            for given in link.from_node.inputs:
                yield from upstream(given)

    images = [n for n in tree.nodes if n.type == 'TEX_IMAGE' and n.image and n.image.size[0]]
    fed = [
        n for shader in tree.nodes for socket in shader.inputs if socket.name in ('Color', 'Base Color')
        for n in upstream(socket) if n in images
    ]
    named = [n for n in images if not any(word in n.image.name.lower() for word in NOT_COLOUR)]
    chosen = (fed or named or [None])[0]
    return chosen.image if chosen else None


def repaint(building, name):
    """Each material rebuilt as a matte base colour, named for the building so no two
    buildings' materials can be mistaken for one when the board merges by name -- and
    one material to an image, which several packs ship twice over, as a .png and a
    .tga."""
    made = {}
    for slot in building.material_slots:
        old = slot.material
        if old is None:
            continue
        image = colour_of(old)
        same = os.path.splitext(os.path.basename(image.filepath))[0].lower() if image else None
        if same and same in made:
            slot.material = made[same]
            if not old.users:
                bpy.data.materials.remove(old)
            continue
        material = bpy.data.materials.new(f'{name}-{len(made)}')
        made[same or object()] = material
        material.use_nodes = True
        nodes = material.node_tree.nodes
        bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
        bsdf.inputs['Metallic'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = 1.0
        if image:
            node = nodes.new('ShaderNodeTexImage')
            node.image = image
            material.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = old.diffuse_color
        slot.material = material
        if not old.users:
            bpy.data.materials.remove(old)
