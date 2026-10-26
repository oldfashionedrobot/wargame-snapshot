"""
The gun, a falconet on a truck carriage, answering to the names the figures use: it
stands at rest; it walks by rolling, its four wheels turning, with a bob and a rock
so that it reads as moving at board scale; it recoils when it fires, the barrel
running back on the carriage; and it falls by coming apart -- wheels off and flat,
carriage to the ground, barrel tipped over its front.
"""
from rig import Body, merge, move, rot

# Each wheel hangs on a bone of its own at its hub, two to a side; the left pair is
# on +X.
LEFT = ('l axle fr', 'trail axle')
RIGHT = ('r axle fr01', 'trail axle01')
CARRIAGE = 'rangefinder'
BARREL = 'recoil con'


def _wheels(degrees):
    return {wheel: rot(('X', degrees)) for wheel in LEFT + RIGHT}


def _falconet(rig):
    rest = {}
    # A turn of the wheels a second, keyed every frame so no step is more than a
    # twelfth of one, with the carriage bobbing twice and rocking side to side once.
    walk = []
    for frame in range(13):
        bob = 0.06 if frame % 6 == 3 else 0.0
        rock = {3: 2.5, 9: -2.5}.get(frame, 0.0)
        walk.append([frame, merge(_wheels(30 * frame), {'root': {**rot(('Y', rock)), **move(0, 0, bob)}})])

    # Coming apart: the wheels fall away outward and lie flat, the carriage drops to
    # the ground and leans, and the barrel tips forward over its front.
    def broken(share):
        def wheel(side):
            return {**rot(('Y', side * 88 * share)), **move(side * 0.8 * share, 0, 0.1 * share)}

        return {
            **{name: wheel(1) for name in LEFT},
            **{name: wheel(-1) for name in RIGHT},
            CARRIAGE: {**rot(('Y', 8 * share), ('X', 5 * share)), **move(0, 0, -0.22 * share)},
            BARREL: {**rot(('X', 20 * share)), **move(0, -0.25 * share, 0)},
        }

    return {
        'stand': [[0, rest]],
        'walk': walk,
        'fire': [
            [0, rest],
            [1, merge(_wheels(-20), {'root': move(0, 0.3, 0), BARREL: {**rot(('X', -4)), **move(0, 0.25, 0)}})],
            [3, merge(_wheels(-28), {'root': move(0, 0.4, 0), BARREL: move(0, 0.12, 0)})],
            [8, rest],
        ],
        'fall': [[0, rest], [3, broken(0.3)], [6, broken(0.75)], [10, broken(1)]],
    }


falconet = Body(_falconet)
