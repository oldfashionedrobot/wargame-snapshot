"""
A general's flag: a pole beside the rider's left hip and a flag flying back from
it, as a flag does from a rider going forward, skinned to the rider's seat so it
rides every animation and falls with him.
"""
import math

import bmesh
import bpy

from rig import join

SEAT = 'dbutt'
WIDTH, HEIGHT, WOOD = 64, 40, 8  # the flag's pixels, and a band below it for the pole

CRIMSON = (0.62, 0.07, 0.11)
UNION_BLUE = (0.0, 0.14, 0.42)
CONTINENTAL_BLUE = (0.09, 0.18, 0.46)
WHITE = (0.95, 0.94, 0.9)
WOOD_BROWN = (0.33, 0.21, 0.1)


def kings(x, y):
    """A British standard: crimson, the Union of 1606 in the canton."""
    w, h = 28, 20
    cx, cy = x, y - (HEIGHT - h)
    if not (0 <= cx < w and 0 <= cy < h):
        return CRIMSON
    px, py = cx + 0.5, cy + 0.5
    cross = min(abs(px - w / 2), abs(py - h / 2))
    if cross < 1.6:
        return CRIMSON
    if cross < 2.8:
        return WHITE
    diagonal = min(abs(px * h - py * w), abs(px * h + py * w - w * h)) / math.hypot(w, h)
    return WHITE if diagonal < 1.6 else UNION_BLUE


def _star_points():
    """Washington's thirteen, in columns of three and two."""
    points = []
    for column, count in enumerate((3, 2, 3, 2, 3)):
        x = WIDTH * (column + 1) / 6
        rows = (0.22, 0.5, 0.78) if count == 3 else (0.36, 0.64)
        points += [(x, HEIGHT * r) for r in rows]
    return points


STARS = _star_points()


def washingtons(x, y):
    """Washington's headquarters standard: thirteen white stars on blue."""
    for sx, sy in STARS:
        dx, dy = round(x + 0.5 - sx), round(y + 0.5 - sy)
        if (dy == 0 and abs(dx) <= 2) or (dx == 0 and abs(dy) <= 2) or (abs(dx) == abs(dy) == 1):
            return WHITE
    return CONTINENTAL_BLUE


def carry_flag(armature, mesh, design):
    """Builds the pole and flag beside the rider, painted by `design(x, y)`, and joins
    them to the figure, skinned wholly to the seat."""
    bones = armature.data.bones
    seat, hat = bones[SEAT].head_local, bones['plume'].head_local
    # Beside the left hip (the figures face -Y, so +X is the rider's left and +Y
    # behind him) and a little back, from the stirrup to well above the hat.
    pole_x, pole_y = 0.45, 0.25
    bottom, top = seat.z - 0.7, hat.z + 1.4
    flag_width, flag_height = 2.0, 1.4
    half = 0.045

    bm = bmesh.new()
    # ⚠️ Named as the figure's first, or joining puts these coordinates in a layer
    # of their own and leaves the flag's first all one corner of its picture.
    uv = bm.loops.layers.uv.new(mesh.data.uv_layers[0].name)
    wood = (0.5, WOOD / 2 / (HEIGHT + WOOD))

    corners = [(-half, -half), (half, -half), (half, half), (-half, half)]
    low = [bm.verts.new((pole_x + dx, pole_y + dy, bottom)) for dx, dy in corners]
    high = [bm.verts.new((pole_x + dx, pole_y + dy, top)) for dx, dy in corners]
    for i in range(4):
        j = (i + 1) % 4
        face = bm.faces.new((low[i], low[j], high[j], high[i]))
        for loop in face.loops:
            loop[uv].uv = wood
    for loop in bm.faces.new(high[::-1]).loops:
        loop[uv].uv = wood

    # Back from the pole in four panels, waving side to side.
    waves = (0.0, 0.16, -0.1, 0.14, 0.0)
    v0 = WOOD / (HEIGHT + WOOD)
    columns = []
    for i, wave in enumerate(waves):
        u = i / (len(waves) - 1)
        y = pole_y + half + u * flag_width
        columns.append((u, bm.verts.new((pole_x + wave, y, top - flag_height)), bm.verts.new((pole_x + wave, y, top))))
    for (u0, a0, b0), (u1, a1, b1) in zip(columns, columns[1:]):
        face = bm.faces.new((a0, a1, b1, b0))
        for loop, at in zip(face.loops, ((u0, v0), (u1, v0), (u1, 1), (u0, 1))):
            loop[uv].uv = at

    data = bpy.data.meshes.new('flag')
    bm.to_mesh(data)
    bm.free()
    flag = bpy.data.objects.new('flag', data)
    bpy.context.collection.objects.link(flag)
    flag.data.materials.append(_material(design))
    group = flag.vertex_groups.new(name=SEAT)
    group.add(range(len(data.vertices)), 1.0, 'REPLACE')
    join(armature, mesh, flag)


def _material(design):
    """The flag's own small texture: the design over a band of wood for the pole."""
    image = bpy.data.images.new('flag', WIDTH, HEIGHT + WOOD, alpha=False)
    pixels = []
    for y in range(HEIGHT + WOOD):
        for x in range(WIDTH):
            colour = WOOD_BROWN if y < WOOD else design(x, y - WOOD)
            pixels += [*colour, 1.0]
    image.pixels.foreach_set(pixels)

    material = bpy.data.materials.new('flag')
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    texture = nodes.new('ShaderNodeTexImage')
    texture.image = image
    # Nearest, so a flag this small stays crisp rather than smearing its stars.
    texture.interpolation = 'Closest'
    material.node_tree.links.new(texture.outputs['Color'], bsdf.inputs['Base Color'])
    return material
