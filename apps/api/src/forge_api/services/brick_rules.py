"""Where a building brick may go: @forge/lobby's bricks.ts, line for line, so the API
has the last word on what the browser shows before it asks.

The grid: x and z count studs (STUD metres each) from the cave's middle, y counts plates
(a brick is three plates tall) up from the floor. A brick's (x, y, z) is its lowest corner
cell; `rot` is quarter turns. A placed brick is loose until another is fastened to it,
stud to tube, above or below: then it's frozen for everyone but the brick maker.
"""

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Final, Literal

STUD: Final = 0.2
#: Building stays this far inside the walking disk's edge (metres).
RADIUS: Final = 24.0
#: The highest a brick may reach, in plates.
MAX_PLATES: Final = 250
#: How many bricks the cave holds, all told.
LIMIT: Final = 5000


@dataclass(frozen=True)
class Shape:
    sx: int
    sz: int
    h: int
    slope: bool = False


SHAPES: Final[dict[str, Shape]] = {
    "brick-1x1": Shape(1, 1, 3),
    "brick-1x2": Shape(2, 1, 3),
    "brick-1x4": Shape(4, 1, 3),
    "brick-2x2": Shape(2, 2, 3),
    "brick-2x4": Shape(4, 2, 3),
    "plate-1x2": Shape(2, 1, 1),
    "plate-2x2": Shape(2, 2, 1),
    "plate-2x4": Shape(4, 2, 1),
    "slope-2x2": Shape(2, 2, 3, slope=True),
}

Problem = Literal["shape", "outside", "overlap", "floating"]
Cell = tuple[int, int]


@dataclass(frozen=True)
class At:
    """A brick where it sits."""

    shape: str
    x: int
    y: int
    z: int
    rot: int


def _turned(shape: Shape, rot: int, i: int, j: int) -> Cell:
    if rot == 0:
        return (i, j)
    if rot == 1:
        return (shape.sz - 1 - j, i)
    if rot == 2:
        return (shape.sx - 1 - i, shape.sz - 1 - j)
    return (j, shape.sx - 1 - i)


def _cells(brick: At, studs_only: bool) -> list[Cell]:
    shape = SHAPES.get(brick.shape)
    if shape is None:
        return []
    rows = 1 if studs_only and shape.slope else shape.sz
    out: list[Cell] = []
    for i in range(shape.sx):
        for j in range(rows):
            dx, dz = _turned(shape, brick.rot, i, j)
            out.append((brick.x + dx, brick.z + dz))
    return out


def cells(brick: At) -> list[Cell]:
    """The columns (x, z) a brick covers."""
    return _cells(brick, studs_only=False)


def studs(brick: At) -> list[Cell]:
    """The columns where its top has studs (a slope: only its high row)."""
    return _cells(brick, studs_only=True)


def height(brick: At) -> int:
    shape = SHAPES.get(brick.shape)
    return shape.h if shape else 0


def _shares(a: Iterable[Cell], b: Iterable[Cell]) -> bool:
    return not set(a).isdisjoint(b)


def overlap(a: At, b: At) -> bool:
    if a.y >= b.y + height(b) or b.y >= a.y + height(a):
        return False
    return _shares(cells(a), cells(b))


def connected(a: At, b: At) -> bool:
    if a.y + height(a) == b.y:
        return _shares(studs(a), cells(b))
    if b.y + height(b) == a.y:
        return _shares(studs(b), cells(a))
    return False


def problem(brick: At, placed: Sequence[At]) -> Problem | None:
    """Why `brick` can't go where it says among `placed`; None when it can."""
    shape = SHAPES.get(brick.shape)
    if shape is None or brick.rot not in (0, 1, 2, 3):
        return "shape"
    if brick.y < 0 or brick.y + shape.h > MAX_PLATES:
        return "outside"
    reach = RADIUS / STUD
    for x, z in cells(brick):
        for cx, cz in ((x, z), (x + 1, z), (x, z + 1), (x + 1, z + 1)):
            if math.hypot(cx, cz) > reach:
                return "outside"
    if any(overlap(brick, other) for other in placed):
        return "overlap"
    if brick.y > 0 and not any(connected(brick, other) for other in placed):
        return "floating"
    return None


def frozen(brick: At, placed: Sequence[At]) -> bool:
    """Whether another placed brick is fastened to it (`placed` may include it)."""
    return any(other is not brick and connected(brick, other) for other in placed)


def _studs_set(brick: At) -> set[Cell]:
    return set(studs(brick))


def blueprint_problems(bricks: Sequence[At], placed: Sequence[At]) -> list[Problem | None]:
    """Why each brick of a build can't go where it says among `placed` (None where it
    can): a shape we don't have, out of the build circle, overlapping a brick (of the cave
    or of the build), or in a group that rests on nothing (neither the floor nor a placed
    brick, through the build's own fastenings). @forge/lobby's `blueprintProblems`."""
    everything: list[tuple[At, int]] = [(brick, i) for i, brick in enumerate(bricks)]
    everything += [(brick, -1) for brick in placed]

    def valid(brick: At) -> bool:
        return brick.shape in SHAPES and brick.rot in (0, 1, 2, 3)

    columns: dict[Cell, list[int]] = {}
    for index, (brick, _) in enumerate(everything):
        if valid(brick):
            for cell in cells(brick):
                columns.setdefault(cell, []).append(index)
    problems: list[Problem | None] = [None] * len(bricks)
    links: list[list[int]] = [[] for _ in bricks]
    grounded = [brick.y == 0 for brick in bricks]
    reach = RADIUS / STUD
    for i, brick in enumerate(bricks):
        if not valid(brick):
            problems[i] = "shape"
            continue
        top = brick.y + height(brick)
        if brick.y < 0 or top > MAX_PLATES:
            problems[i] = "outside"
            continue
        mine = cells(brick)
        corners = ((x + dx, z + dz) for x, z in mine for dx in (0, 1) for dz in (0, 1))
        if any(math.hypot(cx, cz) > reach for cx, cz in corners):
            problems[i] = "outside"
            continue
        my_studs = _studs_set(brick)
        seen: set[int] = set()
        for cell in mine:
            for j in columns.get(cell, []):
                if j == i or j in seen:
                    continue
                seen.add(j)
                other, theirs = everything[j]
                other_top = other.y + height(other)
                if brick.y < other_top and other.y < top:
                    problems[i] = "overlap"
                    continue
                on_it = brick.y == other_top and not _studs_set(other).isdisjoint(mine)
                under_it = other.y == top and not my_studs.isdisjoint(cells(other))
                if not on_it and not under_it:
                    continue
                if theirs < 0:
                    grounded[i] = True
                else:
                    links[i].append(theirs)
    stands = list(grounded)
    queue = [i for i, on in enumerate(stands) if on]
    while queue:
        i = queue.pop()
        for j in links[i]:
            if not stands[j]:
                stands[j] = True
                queue.append(j)
    return [
        problem if problem is not None or stands[i] else "floating"
        for i, problem in enumerate(problems)
    ]


def floor_spot(shape: str, rot: int, x: int, z: int, placed: Sequence[At]) -> At | None:
    """A free spot on the floor nearest the cell (x, z), in rings around it."""
    for ring in range(13):
        for dx in range(-ring, ring + 1):
            for dz in range(-ring, ring + 1):
                if max(abs(dx), abs(dz)) != ring:
                    continue
                brick = At(shape, x + dx, 0, z + dz, rot)
                if problem(brick, placed) is None:
                    return brick
    return None
