"""
The figures on horseback -- cavalry and generals, who share the dragoon's skeleton.
The horse's legs turn from where they stand, so the model's own bends survive; the
rider's arms are aimed, the sabre along the axis measured from the model.
"""
from rig import Body, aim, merge, move, rot


def _legs(fl, fr, hl, hr, fold_front=0, fold_hind=0, bob=0, pitch=0):
    """Each leg's swing about the armature's X in degrees, negative reaching forward."""
    return {
        'sholderlef': rot(('X', fl)), 'wristleft': rot(('X', fold_front)),
        'shoulderri': rot(('X', fr)), 'wristright': rot(('X', fold_front)),
        'hipleft': rot(('X', hl)), 'heelleft': rot(('X', -fold_hind)),
        'hipright': rot(('X', hr)), 'heelright': rot(('X', -fold_hind)),
        'root01': {**rot(('X', pitch)), **move(0, 0, bob)},
        'neck01': rot(('X', -pitch * 1.5)),
    }


def _cavalry(rig):
    sabre = rig.carried('ammo node 0', 'dwristrigh')
    reins = {'dsholderle': aim((0.3, -0.5, -0.8)), 'delbowrigh': aim((-0.1, -0.95, -0.15))}
    sloped = {
        'dsholderri': aim((-0.35, 0.1, -0.93)), 'delbowrig0': aim((-0.05, -0.6, 0.8)),
        'dwristrigh': aim((-0.05, 0.25, 0.97), sabre),
    }
    raised = {
        'dsholderri': aim((-0.45, -0.2, 0.87)), 'delbowrig0': aim((-0.1, -0.55, 0.83)),
        'dwristrigh': aim((0, -0.55, 0.84), sabre),
    }
    cut = {
        'dsholderri': aim((-0.4, -0.85, -0.3)), 'delbowrig0': aim((-0.15, -0.9, -0.4)),
        'dwristrigh': aim((-0.1, -0.75, -0.65), sabre),
    }
    stand = merge(reins, sloped)

    # A trot: diagonal pairs reaching together, a lift between.
    reach = _legs(-18, 14, 12, -14)
    lift = _legs(0, 0, 0, 0, fold_front=45, fold_hind=25, bob=0.08)
    other = _legs(14, -18, -14, 12)

    extended = _legs(-38, -30, 34, 26, bob=0.1, pitch=4)
    landing = _legs(-10, 5, 10, -5, fold_front=30, fold_hind=20)
    gathered = _legs(28, 34, -30, -36, fold_front=70, fold_hind=45, bob=0.35, pitch=-4)

    return {
        'stand': [[0, stand]],
        'walk': [
            [0, merge(stand, reach)], [3, merge(stand, lift)], [6, merge(stand, other)],
            [9, merge(stand, lift)], [12, merge(stand, reach)],
        ],
        'gallop': [
            [0, merge(reins, raised, extended)], [2, merge(reins, raised, landing)],
            [4, merge(reins, raised, gathered)], [6, merge(reins, raised, extended)],
        ],
        'cut': [
            [0, merge(reins, raised)], [2, merge(reins, cut)],
            [4, merge(reins, cut)], [7, merge(reins, raised)],
        ],
        'hit': [
            [0, stand],
            [2, merge(stand, {'dsholder': rot(('X', -14)), 'neck01': rot(('X', -12))})],
            [6, stand],
        ],
        # The forelegs give, then the hind, and the horse goes over on its side.
        'fall': [
            [0, stand],
            [3, merge(stand, _legs(40, 40, 0, 0, fold_front=80, bob=-0.6, pitch=12))],
            [6, merge(stand, _legs(40, 40, -35, -35, fold_front=80, fold_hind=60, bob=-1.6, pitch=6))],
            [10, merge(stand, _legs(30, 30, -25, -25, fold_front=50, fold_hind=40), {
                'root01': {**rot(('Y', 80)), **move(-0.4, 0, -2.3)},
                'dsholder': rot(('Y', 20)),
            })],
        ],
    }


cavalry = Body(_cavalry)
