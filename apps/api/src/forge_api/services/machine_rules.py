"""Where a machine may go in the cave: a mirror of @forge/lobby's machine.ts rules
(`machineExtent`, `machineFootprint`, `machineProblem`), held to the same answers by
tests/test_lobby_machines.py.

A machine stands on the floor at (x, z) metres from the cave's middle, turned `turn`
steps of 15 degrees. Its blueprint is scaled so its longest side is SIZE metres, times
`scale`. Its footprint is the floor box around it, turned; it must stay inside the
building circle, and off every other machine and every brick.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal

from forge_api.services import brick_rules

#: A blueprint's longest side at scale 1, metres.
SIZE: Final = 1.2
#: How many machines the cave holds.
LIMIT: Final = 40
#: Steps in a whole turn.
TURNS: Final = 24
#: Room left between two footprints that touch (floating-point slack).
_SLACK: Final = 1e-9

Problem = Literal["outside", "overlap", "bricks"]


@dataclass(frozen=True)
class Spot:
    """A machine where it stands: its blueprint's size (its own units) and its placing."""

    size: tuple[float, float, float]
    x: float
    z: float
    turn: int
    scale: float


@dataclass(frozen=True)
class Box:
    min_x: float
    max_x: float
    min_z: float
    max_z: float


def extent(size: tuple[float, float, float], scale: float) -> tuple[float, float, float]:
    """Its width, height and depth in metres."""
    k = SIZE * scale / max(size)
    return (size[0] * k, size[1] * k, size[2] * k)


def footprint(spot: Spot) -> Box:
    """The floor box around it, turned."""
    w, _, d = extent(spot.size, spot.scale)
    angle = spot.turn * 2 * math.pi / TURNS
    c = abs(math.cos(angle))
    s = abs(math.sin(angle))
    hw = (w * c + d * s) / 2
    hd = (w * s + d * c) / 2
    return Box(spot.x - hw, spot.x + hw, spot.z - hd, spot.z + hd)


def _overlap(a: Box, b: Box) -> bool:
    return (
        a.min_x < b.max_x - _SLACK
        and b.min_x < a.max_x - _SLACK
        and a.min_z < b.max_z - _SLACK
        and b.min_z < a.max_z - _SLACK
    )


def _brick_boxes(bricks: Sequence[brick_rules.At]) -> list[Box]:
    stud = brick_rules.STUD
    return [
        Box(cx * stud, (cx + 1) * stud, cz * stud, (cz + 1) * stud)
        for brick in bricks
        for cx, cz in brick_rules.cells(brick)
    ]


def problem(spot: Spot, others: Sequence[Spot], bricks: Sequence[brick_rules.At]) -> Problem | None:
    """Why it can't stand there, or None."""
    box = footprint(spot)
    far_x = max(abs(box.min_x), abs(box.max_x))
    far_z = max(abs(box.min_z), abs(box.max_z))
    if math.hypot(far_x, far_z) > brick_rules.RADIUS:
        return "outside"
    if any(_overlap(box, footprint(other)) for other in others):
        return "overlap"
    if any(_overlap(box, cell) for cell in _brick_boxes(bricks)):
        return "bricks"
    return None
