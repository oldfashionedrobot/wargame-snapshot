"""
Poses for a figure's skeleton, written as where its limbs point, and keyed into
named Actions.

Directions and positions are the armature's, in the source model's own units:
forward -Y, the figure's left +X, up +Z. A pose maps bone names to one of:

  aim(to, frm)  the bone's rest direction `frm` -- a vector, or the name of the
                bone it points at -- is turned to point along `to`, absolutely,
                whatever its parent did
  rot(turns)    turns about the armature's axes, on top of what its parent did
  move(x, y, z) shifts the bone, in armature space, on top of where it was
  reach(...)    on an upper arm: bends it and its forearm so the forearm's end
                lands on a target, the elbow toward a pole

Bones not named inherit their parent's turn, so a pose names only what moves.
"""
import math

from mathutils import Matrix, Vector


def aim(to, frm=None):
    return {'aim': (to, frm)}


def rot(*turns):
    return {'rot': turns}


def move(x, y, z):
    return {'move': (x, y, z)}


def reach(target, pole, end=None):
    """`end` is the bone whose head the forearm carries to `target`; without one,
    the forearm is taken as long as the upper arm."""
    return {'reach': (target, pole, end)}


def merge(*parts):
    """One pose from several. A later part's spec for a bone replaces an earlier one's
    whole -- a bone wanting two, a turn and a shift, is given both in one part."""
    out = {}
    for part in parts:
        out.update(part)
    return out


class Body:
    """What a kind of figure does: its Actions, made from its rig."""

    def __init__(self, actions):
        self.actions = actions


class Rig:
    def __init__(self, armature, mesh):
        self.armature = armature
        self.mesh = mesh
        self.bones = armature.data.bones
        self.order = []

        def visit(bone):
            self.order.append(bone)
            for child in bone.children:
                visit(child)

        for root in [b for b in self.bones if b.parent is None]:
            visit(root)

    def head(self, name):
        return self.bones[name].head_local.copy()

    def direction(self, name, toward=None):
        """Where a bone points at rest: toward a named bone, or its only child."""
        bone = self.bones[name]
        if toward is None:
            if len(bone.children) != 1:
                raise ValueError(f'{name} has {len(bone.children)} children; say which it points at')
            toward = bone.children[0].name
        return (self.head(toward) - bone.head_local).normalized()

    def carried(self, group, hand):
        """The direction from `hand` to the farthest point of what `group` carries: a weapon's axis."""
        index = self.mesh.vertex_groups[group].index
        origin = self.head(hand)
        far = None
        for v in self.mesh.data.vertices:
            if any(g.group == index and g.weight > 0.5 for g in v.groups):
                point = self.mesh.matrix_world @ v.co
                if far is None or (point - origin).length > (far - origin).length:
                    far = point
        if far is None:
            raise ValueError(f'nothing is carried by {group}')
        return (far - origin).normalized()

    def solve(self, spec_by_bone):
        """Each bone's pose -- a rotation and a location in its own rest frame."""
        world, pos, out, forced = {}, {}, {}, {}
        for bone in self.order:
            spec = forced.get(bone.name) or spec_by_bone.get(bone.name, {})
            parent = world[bone.parent.name] if bone.parent else Matrix.Identity(3)
            if bone.parent:
                pos[bone.name] = pos[bone.parent.name] + parent @ (bone.head_local - bone.parent.head_local)
            else:
                pos[bone.name] = bone.head_local.copy()
            shift = Vector(spec.get('move', (0, 0, 0)))
            pos[bone.name] += shift

            if 'reach' in spec:
                target, pole, end = spec['reach']
                fore = bone.children[0]
                upper_len = (fore.head_local - bone.head_local).length
                fore_len = (self.bones[end].head_local - fore.head_local).length if end else upper_len
                elbow, hand = _two_bone(pos[bone.name], Vector(target), upper_len, fore_len, Vector(pole))
                spec = {'aim': (elbow - pos[bone.name], fore.name)}
                forced[fore.name] = {'aim': (hand - elbow, end or self.direction(bone.name))}

            if 'aim' in spec:
                to, frm = spec['aim']
                if frm is None or isinstance(frm, str):
                    frm = self.direction(bone.name, frm)
                w = Vector(frm).normalized().rotation_difference(Vector(to).normalized()).to_matrix()
            else:
                turn = Matrix.Identity(3)
                for axis, degrees in spec.get('rot', ()):
                    turn = Matrix.Rotation(math.radians(degrees), 3, axis) @ turn
                w = turn @ parent
            world[bone.name] = w

            rest = bone.matrix_local.to_3x3()
            rotation = (rest.inverted() @ parent.inverted() @ w @ rest).to_quaternion()
            location = rest.inverted() @ parent.inverted() @ shift
            out[bone.name] = (rotation, location)
        return out

    def key(self, name, keys):
        """One Action, `keys` being [frame, pose] pairs, laid on an NLA track so it exports."""
        import bpy

        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        self.armature.animation_data_create()
        self.armature.animation_data.action = action
        for frame, pose in keys:
            for bone_name, (rotation, location) in self.solve(pose).items():
                pb = self.armature.pose.bones[bone_name]
                pb.rotation_mode = 'QUATERNION'
                pb.rotation_quaternion = rotation
                pb.location = location
                pb.keyframe_insert('rotation_quaternion', frame=frame)
                pb.keyframe_insert('location', frame=frame)
        track = self.armature.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, int(keys[0][0]), action)
        self.armature.animation_data.action = None


def _two_bone(shoulder, target, upper, fore, pole):
    """Where the elbow goes for an arm of these lengths reaching `target`, bent toward `pole`."""
    to = target - shoulder
    d = min(to.length, (upper + fore) * 0.999)
    u = to.normalized()
    v = pole - u * pole.dot(u)
    v = v.normalized() if v.length > 1e-6 else Vector((0, 0, -1))
    cos_a = max(-1.0, min(1.0, (upper * upper + d * d - fore * fore) / (2 * upper * d)))
    sin_a = math.sqrt(max(0.0, 1 - cos_a * cos_a))
    elbow = shoulder + upper * (cos_a * u + sin_a * v)
    return elbow, shoulder + u * d


def join(armature, mesh, part):
    """Skins `part` to the figure's armature and joins it into the figure's mesh."""
    import bpy

    part.parent = armature
    skin = next((m for m in part.modifiers if m.type == 'ARMATURE'), None)
    (skin or part.modifiers.new('Armature', 'ARMATURE')).object = armature
    bpy.ops.object.select_all(action='DESELECT')
    part.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.join()
