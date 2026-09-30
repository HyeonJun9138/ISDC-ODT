"""Build SpaceTwin's own representative satellite shapes as glTF binaries with thumbnails.

The public NASA collection has no models for the constellations that dominate the GP catalog
(Starlink, OneWeb, GNSS, 3U CubeSats). These generated shapes are deliberately simple box and
cylinder assemblies at approximate real-world dimensions. They are representative forms, not
manufacturer geometry, and the UI labels them as SpaceTwin-built representatives.

Authoring frame (glTF, metres): +Y zenith, -Y nadir (Earth-facing), +Z along the velocity vector,
X cross-track. Cesium converts glTF Y-up/Z-forward into its Z-up/X-forward body frame, which the
model layer aligns with the propagated velocity frame, so the nadir face points at Earth.

Usage:
    python project_support/tools/build_generic_models.py            # write GLB + JPEG thumbnails
    python project_support/tools/build_generic_models.py --check    # rebuild in memory and compare
"""
from __future__ import annotations

import argparse
import io
import json
import math
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = ROOT / "user_application" / "web" / "assets" / "models"
THUMBNAIL_BACKGROUND = (6, 16, 27)
GENERATOR = "SpaceTwin build_generic_models"

MATERIALS = {
    "bus_white": {"color": (0.86, 0.87, 0.90), "metallic": 0.15, "roughness": 0.65},
    "bus_gold": {"color": (0.80, 0.62, 0.26), "metallic": 0.60, "roughness": 0.45},
    "bus_dark": {"color": (0.17, 0.18, 0.21), "metallic": 0.45, "roughness": 0.60},
    "solar": {"color": (0.10, 0.15, 0.38), "metallic": 0.25, "roughness": 0.35},
    "antenna": {"color": (0.74, 0.75, 0.78), "metallic": 0.70, "roughness": 0.35},
    "radiator": {"color": (0.93, 0.94, 0.96), "metallic": 0.05, "roughness": 0.75},
}


class Assembly:
    """Collects boxes and cylinders as flat-shaded triangle primitives."""

    def __init__(self, name: str):
        self.name = name
        self.parts: list[dict] = []

    def box(self, center, size, material):
        cx, cy, cz = center
        hx, hy, hz = (s / 2 for s in size)
        faces = [
            ((1, 0, 0), [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)]),
            ((-1, 0, 0), [(-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz), (-hx, -hy, -hz)]),
            ((0, 1, 0), [(-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz)]),
            ((0, -1, 0), [(-hx, -hy, hz), (-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz)]),
            ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
            ((0, 0, -1), [(hx, -hy, -hz), (-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz)]),
        ]
        positions, normals, indices = [], [], []
        for normal, corners in faces:
            base = len(positions)
            for x, y, z in corners:
                positions.append((cx + x, cy + y, cz + z))
                normals.append(normal)
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
        self.parts.append({"material": material, "positions": positions, "normals": normals, "indices": indices})

    def cylinder(self, center, radius, height, material, axis="y", segments=18):
        cx, cy, cz = center
        positions, normals, indices = [], [], []
        ring = []
        for i in range(segments):
            angle = 2 * math.pi * i / segments
            ring.append((math.cos(angle), math.sin(angle)))

        def place(u, v, along):
            if axis == "y":
                return (cx + u, cy + along, cz + v)
            if axis == "x":
                return (cx + along, cy + u, cz + v)
            return (cx + u, cy + v, cz + along)

        def normal_of(u, v, along=0.0):
            if axis == "y":
                return (u, along, v)
            if axis == "x":
                return (along, u, v)
            return (u, v, along)

        half = height / 2
        for i in range(segments):
            u0, v0 = ring[i]
            u1, v1 = ring[(i + 1) % segments]
            base = len(positions)
            positions.extend([
                place(radius * u0, radius * v0, -half), place(radius * u1, radius * v1, -half),
                place(radius * u1, radius * v1, half), place(radius * u0, radius * v0, half),
            ])
            normals.extend([normal_of(u0, v0), normal_of(u1, v1), normal_of(u1, v1), normal_of(u0, v0)])
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
        for sign in (1, -1):
            base = len(positions)
            positions.append(place(0, 0, sign * half))
            normals.append(normal_of(0, 0, sign))
            for u, v in ring:
                positions.append(place(radius * u, radius * v, sign * half))
                normals.append(normal_of(0, 0, sign))
            for i in range(segments):
                a, b = base + 1 + i, base + 1 + (i + 1) % segments
                indices.extend([base, a, b] if sign > 0 else [base, b, a])
        self.parts.append({"material": material, "positions": positions, "normals": normals, "indices": indices})

    def bounds(self):
        xs = [p[0] for part in self.parts for p in part["positions"]]
        ys = [p[1] for part in self.parts for p in part["positions"]]
        zs = [p[2] for part in self.parts for p in part["positions"]]
        return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

    def to_glb(self) -> bytes:
        material_names = list(MATERIALS)
        buffer = bytearray()
        buffer_views, accessors, primitives = [], [], []

        def add_view(data: bytes, target: int) -> int:
            while len(buffer) % 4:
                buffer.append(0)
            buffer_views.append({"buffer": 0, "byteOffset": len(buffer), "byteLength": len(data), "target": target})
            buffer.extend(data)
            return len(buffer_views) - 1

        for part in self.parts:
            positions = part["positions"]
            view = add_view(b"".join(struct.pack("<3f", *p) for p in positions), 34962)
            accessors.append({
                "bufferView": view, "componentType": 5126, "count": len(positions), "type": "VEC3",
                "min": [min(p[i] for p in positions) for i in range(3)],
                "max": [max(p[i] for p in positions) for i in range(3)],
            })
            position_accessor = len(accessors) - 1
            view = add_view(b"".join(struct.pack("<3f", *n) for n in part["normals"]), 34962)
            accessors.append({"bufferView": view, "componentType": 5126, "count": len(part["normals"]), "type": "VEC3"})
            normal_accessor = len(accessors) - 1
            wide = len(positions) > 65535
            view = add_view(b"".join(struct.pack("<I" if wide else "<H", i) for i in part["indices"]), 34963)
            accessors.append({"bufferView": view, "componentType": 5125 if wide else 5123, "count": len(part["indices"]), "type": "SCALAR"})
            primitives.append({
                "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor},
                "indices": len(accessors) - 1, "material": material_names.index(part["material"]), "mode": 4,
            })

        document = {
            "asset": {"version": "2.0", "generator": GENERATOR},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "name": self.name}],
            "meshes": [{"name": self.name, "primitives": primitives}],
            "materials": [{
                "name": name,
                "doubleSided": True,
                "pbrMetallicRoughness": {
                    "baseColorFactor": [*spec["color"], 1.0],
                    "metallicFactor": spec["metallic"], "roughnessFactor": spec["roughness"],
                },
            } for name, spec in MATERIALS.items()],
            "buffers": [{"byteLength": len(buffer)}],
            "bufferViews": buffer_views,
            "accessors": accessors,
        }
        json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * (-len(json_bytes) % 4)
        binary = bytes(buffer) + b"\0" * (-len(buffer) % 4)
        total = 12 + 8 + len(json_bytes) + 8 + len(binary)
        return b"".join([
            b"glTF", struct.pack("<II", 2, total),
            struct.pack("<I4s", len(json_bytes), b"JSON"), json_bytes,
            struct.pack("<I4s", len(binary), b"BIN\0"), binary,
        ])

    def triangles(self):
        """Yield (p0, p1, p2, rgb) in glTF space for thumbnail rendering."""
        for part in self.parts:
            color = MATERIALS[part["material"]]["color"]
            positions, indices = part["positions"], part["indices"]
            for i in range(0, len(indices), 3):
                yield positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]], color

    def thumbnail(self, width: int = 640) -> bytes:
        return paint_triangles(self.triangles(), width)


def paint_triangles(triangles, width: int = 640, view=(-1.0, 0.85, -1.35), light=(-0.4, 1.0, -0.7)) -> bytes:
    """Flat-shaded orthographic JPEG of glTF-space triangles (Y up) from the front-left-above quadrant.

    Shared by the generated shapes and by fetch_nasa_models.py for downloaded models without a
    preview image. Painter's algorithm only, no textures: this is a schematic render, not a photo.
    """
    from PIL import Image, ImageDraw

    view = _normalize(view)
    right = _normalize(_cross((0.0, 1.0, 0.0), view))
    true_up = _cross(view, right)
    light = _normalize(light)
    painted = []
    for p0, p1, p2, color in triangles:
        normal = _normalize(_cross(_sub(p1, p0), _sub(p2, p0)))
        if not any(normal):
            continue
        shade_normal = normal if _dot(normal, view) >= 0 else tuple(-c for c in normal)
        shade = 0.32 + 0.68 * max(0.0, _dot(shade_normal, light))
        depth = (_dot(p0, view) + _dot(p1, view) + _dot(p2, view)) / 3
        projected = [(_dot(p, right), _dot(p, true_up)) for p in (p0, p1, p2)]
        painted.append((depth, projected, tuple(min(255, int(255 * c * shade)) for c in color)))
    if not painted:
        raise ValueError("nothing to render")
    painted.sort(key=lambda item: item[0])
    xs = [x for _, tri, _ in painted for x, _ in tri]
    ys = [y for _, tri, _ in painted for _, y in tri]
    scale_w, scale_h = 2 * width, int(2 * width * 9 / 16)
    span = max(max(xs) - min(xs), (max(ys) - min(ys)) * 16 / 9) or 1.0
    scale = 0.84 * scale_w / span
    ox, oy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    image = Image.new("RGB", (scale_w, scale_h), THUMBNAIL_BACKGROUND)
    draw = ImageDraw.Draw(image)
    for _, tri, color in painted:
        draw.polygon([(scale_w / 2 + (x - ox) * scale, scale_h / 2 - (y - oy) * scale) for x, y in tri], fill=color)
    image = image.resize((width, int(width * 9 / 16)), Image.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=82, optimize=True, progressive=True)
    return output.getvalue()


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _normalize(v):
    length = math.sqrt(_dot(v, v)) or 1.0
    return (v[0] / length, v[1] / length, v[2] / length)


def starlink_flat() -> Assembly:
    """Flat-panel bus with two long solar arrays, after the V2 Mini layout (about 29 m span)."""
    a = Assembly("starlink_flat")
    a.box((0, 0, 0), (2.7, 0.6, 4.1), "bus_dark")
    for x in (-0.65, 0.65):
        for z in (-1.0, 1.0):
            a.box((x, -0.32, z), (1.1, 0.04, 0.9), "radiator")
    a.box((0, 0.33, 0), (2.2, 0.06, 3.4), "bus_white")
    a.box((0, 0.42, -1.5), (0.5, 0.12, 0.5), "antenna")
    for sign in (-1, 1):
        a.box((sign * 1.5, 0.1, 0), (0.3, 0.14, 0.5), "antenna")
        a.box((sign * 8.05, 0.1, 0), (12.8, 0.05, 4.1), "solar")
    return a


def gnss_bus() -> Assembly:
    """Box bus with a nadir helix-antenna array and two solar wings (about 14 m span)."""
    a = Assembly("gnss_bus")
    a.box((0, 0, 0), (2.0, 1.8, 2.5), "bus_gold")
    a.box((0, -0.95, 0), (1.7, 0.1, 1.7), "bus_dark")
    for radius, count in ((0.35, 4), (0.68, 8)):
        for i in range(count):
            angle = 2 * math.pi * i / count + (math.pi / count if count == 8 else 0)
            a.cylinder((radius * math.cos(angle), -1.32, radius * math.sin(angle)), 0.12, 0.62, "antenna", segments=12)
    a.cylinder((0, 1.05, 0), 0.45, 0.3, "antenna", segments=16)
    for sign in (-1, 1):
        a.box((sign * 1.25, 0, 0), (0.5, 0.08, 0.3), "antenna")
        a.box((sign * 4.25, 0, 0), (5.5, 0.05, 1.9), "solar")
    return a


def leo_comms_bus() -> Assembly:
    """Small box bus with nadir antennas and two solar wings (about 6.3 m span)."""
    a = Assembly("leo_comms_bus")
    a.box((0, 0, 0), (1.0, 1.0, 1.3), "bus_white")
    a.box((0, -0.53, 0), (0.9, 0.06, 1.2), "bus_dark")
    for x in (-0.28, 0.28):
        a.cylinder((x, -0.64, 0), 0.24, 0.16, "antenna", segments=16)
    a.box((0, 0.55, -0.35), (0.4, 0.1, 0.4), "antenna")
    for sign in (-1, 1):
        a.box((sign * 0.58, 0, 0), (0.16, 0.06, 0.25), "antenna")
        a.box((sign * 1.9, 0, 0), (2.5, 0.04, 1.0), "solar")
    return a


def cubesat_3u() -> Assembly:
    """3U CubeSat with two deployable wings hinged along the long edge (about 0.7 m span)."""
    a = Assembly("cubesat_3u")
    a.box((0, 0, 0), (0.1, 0.1, 0.34), "bus_dark")
    for x in (-0.048, 0.048):
        for y in (-0.048, 0.048):
            a.box((x, y, 0), (0.008, 0.008, 0.34), "antenna")
    a.box((0, -0.052, 0.1), (0.06, 0.004, 0.1), "radiator")
    for sign in (-1, 1):
        a.box((sign * 0.2, 0.04, 0), (0.3, 0.004, 0.1), "solar")
    return a


BUILDERS = {
    "starlink_flat": starlink_flat,
    "gnss_bus": gnss_bus,
    "leo_comms_bus": leo_comms_bus,
    "cubesat_3u": cubesat_3u,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="rebuild in memory and report whether files on disk match")
    parser.add_argument("--thumbnail-width", type=int, default=640)
    args = parser.parse_args(argv)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    mismatches = 0
    for name, build in BUILDERS.items():
        assembly = build()
        glb = assembly.to_glb()
        low, high = assembly.bounds()
        extent = max(high[i] - low[i] for i in range(3))
        target = MODELS_DIR / f"{name}.glb"
        if args.check:
            same = target.exists() and target.read_bytes() == glb
            mismatches += 0 if same else 1
            print(f"[{'same' if same else 'DIFF'}] {name}.glb extent {extent:.2f} m")
            continue
        target.write_bytes(glb)
        (MODELS_DIR / f"{name}.jpg").write_bytes(assembly.thumbnail(args.thumbnail_width))
        print(f"[build] {name}.glb {len(glb):,} bytes, extent {extent:.2f} m, {len(assembly.parts)} parts")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
