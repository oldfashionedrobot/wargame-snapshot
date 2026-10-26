"""
The figures on foot, who share one skeleton: infantry, gunners with a rammer, and
the unarmed crew. Positions are the source's own units, a man about four tall;
both hands are put on what he carries -- the right on the stock, where the model
grips it, the left along the barrel or the rammer.
"""
from rig import Body, aim, merge, move, reach, rot

DOWN = (0, 0, -1)


def _hold(rig, grip, axis, left_at, r_pole, l_pole):
    """The right hand on `grip`, what it carries along `axis`, the left hand `left_at`
    along it."""
    carried = rig.direction('carpal right', 'ammo node 0')
    length = sum(c * c for c in axis) ** 0.5
    left = tuple(g + c / length * left_at for g, c in zip(grip, axis))
    return {
        'scapula01': reach(grip, r_pole, end='carpal right'),
        'carpal right': aim(axis, carried),
        'scapula': reach(left, l_pole),
    }


def _port(rig):
    return _hold(rig, (-0.3, -0.42, 2.62), (0.5, -0.05, 0.86), 0.9, (-1, 0.6, -0.3), (1, 0, -1))


def _legs(lt, ls, rt, rs):
    return {
        'femurleft': aim(lt, DOWN), 'knee-l-bopttom': aim(ls, DOWN),
        'femurright': aim(rt, DOWN), 'knee-r-bopttom': aim(rs, DOWN),
    }


# A stride and the moment between strides, for the left leg leading; the mirror is
# the right's.
STRIDE = ((0, -0.45, -0.9), (0, -0.2, -1), (0, 0.4, -0.92), (0, 0.55, -0.85))
PASSING = ((0, -0.05, -1), (0, 0.1, -1), (0, -0.1, -1), (0, 0.35, -0.9))
RUN = ((0, -0.7, -0.7), (0, -0.1, -1), (0, 0.55, -0.83), (0, 0.85, -0.5))


def _mirror(legs):
    lt, ls, rt, rs = legs
    return rt, rs, lt, ls


def _bob(z):
    return {'root': move(0, 0, z)}


def _walk(arms):
    """Twelve frames, a second: left stride, passing, right stride, passing."""
    return [
        [0, merge(arms, _legs(*STRIDE), _bob(-0.08))],
        [3, merge(arms, _legs(*PASSING), _bob(0))],
        [6, merge(arms, _legs(*_mirror(STRIDE)), _bob(-0.08))],
        [9, merge(arms, _legs(*_mirror(PASSING)), _bob(0))],
        [12, merge(arms, _legs(*STRIDE), _bob(-0.08))],
    ]


def _run(arms, lean):
    """Eight frames: a running stride each way, leaning `lean` degrees forward."""
    body = {'lumbar': rot(('X', lean))}
    return [
        [0, merge(arms, body, _legs(*RUN), _bob(-0.15))],
        [4, merge(arms, body, _legs(*_mirror(RUN)), _bob(-0.15))],
        [8, merge(arms, body, _legs(*RUN), _bob(-0.15))],
    ]


def _hit(stand):
    return [
        [0, stand],
        [2, merge(stand, {'lumbar': rot(('X', -16)), 'neck': rot(('X', -12))})],
        [6, stand],
    ]


def _fall(rig, stand):
    """Buckling, then down on his back, arms flung out."""
    r_up, l_up = rig.direction('scapula01'), rig.direction('scapula')
    return [
        [0, stand],
        [3, merge(stand, {
            'lumbar': rot(('X', -20)),
            'knee-l-bopttom': rot(('X', 25)),
            'knee-r-bopttom': rot(('X', 25)),
            'root': move(0, 0, -0.3),
        })],
        [8, {
            'root': {**rot(('X', -85)), **move(0, 0.25, -1.85)},
            'scapula01': aim((-1, 0.2, -0.05), r_up), 'ulna01': aim((-0.9, 0.4, -0.05)),
            'carpal right': aim((0.3, -0.95, -0.05), rig.direction('carpal right', 'ammo node 0')),
            'scapula': aim((1, 0.3, -0.05), l_up), 'ulna': aim((0.9, 0.5, -0.05), l_up),
        }],
    ]


def _infantry(rig):
    port = _port(rig)
    present = _hold(rig, (-0.3, -0.55, 3.25), (0.04, -1, 0.02), 0.5, (-1, 0.2, -0.6), (0.5, 0, -1))
    recoil = _hold(rig, (-0.3, -0.38, 3.32), (0.04, -0.96, 0.28), 0.5, (-1, 0.2, -0.6), (0.5, 0, -1))
    bayonet = _hold(rig, (-0.38, 0.0, 2.55), (0.12, -1, 0.1), 0.65, (-1, 0.5, 0), (0.6, -0.2, -1))
    return {
        'stand': [[0, port]],
        'walk': _walk(port),
        'present': [[0, merge(present, {'lumbar': rot(('X', 4))})]],
        'fire': [[0, present], [1, recoil], [4, present], [8, present]],
        'charge': _run(bayonet, 16),
        # A run at the port: away from the enemy, not at him.
        'flee': _run(port, 8),
        'hit': _hit(port),
        'fall': _fall(rig, port),
    }


def _gunner(rig):
    port = _port(rig)
    # The rammer driven home and drawn back, level at the muzzle's height.
    home = _hold(rig, (-0.3, -0.75, 2.95), (0.05, -1, 0.04), 0.7, (-1, 0.3, -0.5), (0.6, 0, -1))
    drawn = _hold(rig, (-0.3, 0.05, 2.95), (0.05, -1, 0.04), 0.7, (-1, 0.3, -0.5), (0.6, 0, -1))
    return {
        'stand': [[0, port]],
        'walk': _walk(port),
        'ram': [[0, drawn], [4, home], [8, home], [12, drawn]],
        'hit': _hit(port),
        'fall': _fall(rig, port),
    }


def _crew(rig):
    # Something carried in the right hand, low in front -- the prop the game gives
    # him -- and the left arm down.
    l_up = rig.direction('scapula')
    carrying = {
        'scapula01': reach((-0.35, -0.5, 2.6), (-1, 0.3, -0.5), end='carpal right'),
        'scapula': aim((0.15, 0, -1), l_up), 'ulna': aim((0.1, -0.12, -1), l_up),
    }
    return {
        'stand': [[0, carrying]],
        'walk': _walk(carrying),
        'hit': _hit(carrying),
        'fall': _fall(rig, carrying),
    }


infantry = Body(_infantry)
gunner = Body(_gunner)
crew = Body(_crew)
