"""Fetch and verify the satellite models listed in the web asset manifest.

The manifest at user_application/web/assets/models/manifest.json is the hand-maintained
source of truth for which models the app ships and how they map to catalog objects. This tool
only performs I/O: it downloads each NASA GLB from the pinned repository commit, verifies the
glTF binary container, shrinks the NASA preview image into a JPEG thumbnail, measures each
model's native extent so the viewer can scale it to real metres, fills in sha256/bytes, and
regenerates the provenance README next to the assets. Models with provider "spacetwin" are
built locally by build_generic_models.py and are only verified and measured here.

Usage:
    python project_support/tools/fetch_nasa_models.py            # download missing or changed files
    python project_support/tools/fetch_nasa_models.py --force    # re-download every NASA model
    python project_support/tools/fetch_nasa_models.py --verify   # check files against the manifest only
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import struct
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = ROOT / "user_application" / "web" / "assets" / "models"
MANIFEST_PATH = MODELS_DIR / "manifest.json"
THUMBNAIL_BACKGROUND = (6, 16, 27)  # matches the inspector shape panel colour
USER_AGENT = "SpaceTwin-VVP asset fetch (https://github.com/HyeonJun9138/ISDC-ODT)"


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def glb_document(data: bytes) -> dict:
    """Return the JSON chunk of a well-formed glTF 2.0 binary container or raise ValueError."""
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("not a GLB container (missing glTF magic)")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ValueError(f"unsupported glTF version {version}")
    if length != len(data):
        raise ValueError(f"declared length {length} differs from file size {len(data)}")
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    if chunk_type != b"JSON":
        raise ValueError("first chunk is not JSON")
    return json.loads(data[20:20 + chunk_length].decode("utf-8"))


def validate_glb(data: bytes) -> None:
    glb_document(data)


def _matrix_multiply(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def _node_matrix(node: dict):
    if "matrix" in node:
        m = node["matrix"]  # column-major per glTF
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    tx, ty, tz = node.get("translation", [0, 0, 0])
    qx, qy, qz, qw = node.get("rotation", [0, 0, 0, 1])
    sx, sy, sz = node.get("scale", [1, 1, 1])
    rotation = [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ]
    scale = (sx, sy, sz)
    return [
        [rotation[0][0] * scale[0], rotation[0][1] * scale[1], rotation[0][2] * scale[2], tx],
        [rotation[1][0] * scale[0], rotation[1][1] * scale[1], rotation[1][2] * scale[2], ty],
        [rotation[2][0] * scale[0], rotation[2][1] * scale[1], rotation[2][2] * scale[2], tz],
        [0, 0, 0, 1],
    ]


def model_extent(document: dict) -> float:
    """Largest axis-aligned dimension of the default scene in native glTF units."""
    accessors = document.get("accessors", [])
    meshes = document.get("meshes", [])
    nodes = document.get("nodes", [])
    scene_index = document.get("scene", 0)
    scenes = document.get("scenes", [])
    roots = scenes[scene_index]["nodes"] if scenes else list(range(len(nodes)))
    identity = [[1 if r == c else 0 for c in range(4)] for r in range(4)]
    low = [math.inf] * 3
    high = [-math.inf] * 3

    def visit(index: int, parent):
        node = nodes[index]
        world = _matrix_multiply(parent, _node_matrix(node))
        if "mesh" in node:
            for primitive in meshes[node["mesh"]].get("primitives", []):
                accessor = accessors[primitive.get("attributes", {}).get("POSITION", -1)] if primitive.get("attributes", {}).get("POSITION") is not None else None
                if not accessor or "min" not in accessor or "max" not in accessor:
                    continue
                for corner in range(8):
                    local = [accessor["max" if corner & (1 << axis) else "min"][axis] for axis in range(3)] + [1]
                    for axis in range(3):
                        value = sum(world[axis][k] * local[k] for k in range(4))
                        low[axis] = min(low[axis], value)
                        high[axis] = max(high[axis], value)
        for child in node.get("children", []):
            visit(child, world)

    for root in roots:
        visit(root, identity)
    if any(math.isinf(value) for value in low + high):
        raise ValueError("no POSITION accessor bounds; cannot measure the model")
    return max(high[axis] - low[axis] for axis in range(3))


_COMPONENTS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def glb_triangles(data: bytes):
    """Yield (p0, p1, p2, rgb) world-space triangles from an uncompressed GLB for schematic rendering."""
    document = glb_document(data)
    if "KHR_draco_mesh_compression" in document.get("extensionsUsed", []):
        raise ValueError("draco-compressed geometry cannot be rendered here")
    chunk_length = struct.unpack_from("<I", data, 12)[0]
    offset = 20 + chunk_length
    binary = b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<I4s", data, offset)
        if kind == b"BIN\0":
            binary = data[offset + 8:offset + 8 + length]
            break
        offset += 8 + length
    accessors, views = document.get("accessors", []), document.get("bufferViews", [])

    def read(index: int):
        accessor = accessors[index]
        view = views[accessor["bufferView"]]
        fmt = _COMPONENTS[accessor["componentType"]]
        count = _COUNTS[accessor["type"]]
        size = struct.calcsize("<" + fmt)
        stride = view.get("byteStride") or size * count
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return [struct.unpack_from("<" + fmt * count, binary, start + i * stride) for i in range(accessor["count"])]

    materials = document.get("materials", [])
    meshes, nodes = document.get("meshes", []), document.get("nodes", [])
    scenes = document.get("scenes", [])
    roots = scenes[document.get("scene", 0)]["nodes"] if scenes else list(range(len(nodes)))
    identity = [[1 if r == c else 0 for c in range(4)] for r in range(4)]

    def visit(index: int, parent):
        node = nodes[index]
        world = _matrix_multiply(parent, _node_matrix(node))
        if "mesh" in node:
            for primitive in meshes[node["mesh"]].get("primitives", []):
                if primitive.get("mode", 4) != 4 or "POSITION" not in primitive.get("attributes", {}):
                    continue
                local = read(primitive["attributes"]["POSITION"])
                positions = [tuple(sum(world[axis][k] * (p[k] if k < 3 else 1) for k in range(4)) for axis in range(3)) for p in local]
                indices = [i[0] for i in read(primitive["indices"])] if "indices" in primitive else list(range(len(positions)))
                material = materials[primitive["material"]] if "material" in primitive else {}
                color = tuple((material.get("pbrMetallicRoughness", {}).get("baseColorFactor") or [0.72, 0.73, 0.76, 1])[:3])
                for i in range(0, len(indices) - 2, 3):
                    yield positions[indices[i]], positions[indices[i + 1]], positions[indices[i + 2]], color
        for child in node.get("children", []):
            yield from visit(child, world)

    for root in roots:
        yield from visit(root, identity)


def render_thumbnail(data: bytes, width: int) -> bytes:
    from build_generic_models import paint_triangles  # sibling tool; shares the schematic painter

    return paint_triangles(glb_triangles(data), width)


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def origin_url(raw_base: str, relative: str) -> str:
    base = raw_base.rstrip("/")
    scheme_and_host, _, base_path = base.partition("://")
    quoted_base = "/".join(urllib.parse.quote(part) for part in base_path.split("/"))
    quoted_relative = "/".join(urllib.parse.quote(part) for part in relative.split("/"))
    return f"{scheme_and_host}://{quoted_base}/{quoted_relative}"


def make_thumbnail(png_bytes: bytes, width: int) -> bytes:
    from PIL import Image  # Pillow is only needed when regenerating thumbnails.

    image = Image.open(io.BytesIO(png_bytes)).convert("RGBA")
    background = Image.new("RGBA", image.size, THUMBNAIL_BACKGROUND + (255,))
    background.alpha_composite(image)
    flattened = background.convert("RGB")
    if flattened.width > width:
        height = max(1, round(flattened.height * width / flattened.width))
        flattened = flattened.resize((width, height), Image.LANCZOS)
    output = io.BytesIO()
    flattened.save(output, format="JPEG", quality=82, optimize=True, progressive=True)
    return output.getvalue()


def write_readme(manifest: dict) -> None:
    sources = manifest["sources"]
    nasa = sources["nasa"]
    lines = [
        "# 위성 3D 모델 자산",
        "",
        "이 폴더의 GLB 모델과 JPG 썸네일은 궤도 탭의 선택 위성 표시에 쓰인다. 매핑 규칙과 대표 치수는 `manifest.json`에 있으며, "
        "NASA 모델 수집과 전체 검증은 `project_support/tools/fetch_nasa_models.py`, 자체 제작 모델 생성은 "
        "`project_support/tools/build_generic_models.py`가 수행한다.",
        "",
        "## 출처",
        "",
        f"- **NASA 3D Resources**: [{nasa['name']}]({nasa['repository']}), 고정 commit `{nasa['commit']}`, 사용 지침 {nasa['usage_guidelines']}. "
        "NASA 자료는 일반적으로 저작권 대상이 아니며 출처를 NASA로 밝힌다. NASA 휘장과 로고는 별도 보호 대상이므로 이 앱은 모델 형상만 사용하고 "
        "NASA의 보증이나 승인을 뜻하지 않는다.",
    ]
    if "spacetwin" in sources:
        lines.append(f"- **SpaceTwin 자체 제작**: {sources['spacetwin'].get('note', '공개 자료가 없는 위성군을 위한 단순 대표 형상이다.')}")
    lines.extend([
        "",
        "표시되는 형상은 실제 촬영 이미지가 아니며, 대표 형상으로 표시하는 경우 실제 기체 외형과 다를 수 있다. "
        "`size_m`은 전개 상태의 최대 치수를 공개 자료에서 어림한 근사값이며 정밀 제원이 아니다.",
        "",
        "| key | 출처 | 모델 | 원본 경로 | 대표 치수 m | bytes | sha256 |",
        "|---|---|---|---|---:|---:|---|",
    ])
    for model in manifest["models"]:
        origin = f"`3D Models/{model['origin']}`" if model.get("origin") else "생성"
        lines.append(f"| `{model['key']}` | {model['provider']} | {model['title']} | {origin} | {model['size_m']} | {model['bytes']:,} | `{model['sha256'][:16]}…` |")
    lines.extend([
        "",
        "## 매핑 의미",
        "",
        "- `exact`: NORAD 번호 또는 이름이 해당 기체와 일치한다. UI는 해당 기체의 모델로 표시한다.",
        "- `series`: 같은 계열 또는 같은 버스의 기체다. UI는 동일 계열 모델로 표시한다.",
        "- `family`: 이름 규칙으로 식별한 위성군이다. UI는 대표 형상으로 표시한다.",
        "- `representatives`: 궤도 구분 및 객체 유형별 대표 형상이다. UI는 대표 형상임을 명시한다.",
        "- 로켓 본체와 파편은 모델을 배정하지 않는다.",
        "",
    ])
    (MODELS_DIR / "README.md").write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--force", action="store_true", help="re-download every NASA model and thumbnail")
    parser.add_argument("--verify", action="store_true", help="only verify local files against the manifest")
    parser.add_argument("--skip-thumbnails", action="store_true", help="do not download or regenerate NASA thumbnails")
    args = parser.parse_args(argv)

    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    sources = manifest["sources"]
    thumbnail_width = int(manifest.get("display", {}).get("thumbnail_width", 640))
    problems: list[str] = []
    total_bytes = 0

    for model in manifest["models"]:
        provider = model.get("provider", "nasa")
        target = MODELS_DIR / model["file"]
        thumbnail = MODELS_DIR / model["thumbnail"]
        if args.verify:
            if not target.exists():
                problems.append(f"{model['key']}: missing {target.name}")
                continue
            data = target.read_bytes()
            try:
                extent = model_extent(glb_document(data))
                if abs(extent - float(model.get("extent") or 0)) > 1e-6 * max(1.0, extent):
                    problems.append(f"{model['key']}: extent {extent:.6g} differs from manifest {model.get('extent')}")
            except ValueError as error:
                problems.append(f"{model['key']}: {error}")
            if sha256_of(data) != model.get("sha256"):
                problems.append(f"{model['key']}: sha256 mismatch")
            if not thumbnail.exists():
                problems.append(f"{model['key']}: missing thumbnail {thumbnail.name}")
            if not (float(model.get("size_m") or 0) > 0):
                problems.append(f"{model['key']}: size_m must be positive")
            total_bytes += len(data)
            continue

        if provider == "spacetwin":
            if not target.exists():
                raise SystemExit(f"{model['key']}: {target.name} is missing; run build_generic_models.py first")
            data = target.read_bytes()
            print(f"[local] {model['key']} ({len(data):,} bytes)")
        else:
            source = sources[provider]
            # A manifest entry without a recorded sha adopts a valid local file instead of re-downloading it.
            local_ok = target.exists() and (not model.get("sha256") or sha256_of(target.read_bytes()) == model["sha256"])
            if local_ok and not model.get("sha256"):
                validate_glb(target.read_bytes())
            needs_model = args.force or not local_ok
            if needs_model:
                url = origin_url(source["raw_base"], model["origin"])
                print(f"[fetch] {model['key']} <- {url}")
                data = download(url)
                validate_glb(data)
                target.write_bytes(data)
            else:
                data = target.read_bytes()
                print(f"[keep ] {model['key']} ({len(data):,} bytes)")
            if not args.skip_thumbnails and (args.force or not thumbnail.exists()):
                if model.get("origin_image"):
                    url = origin_url(source["raw_base"], model["origin_image"])
                    print(f"[thumb] {model['key']} <- {url}")
                    thumbnail.write_bytes(make_thumbnail(download(url), thumbnail_width))
                else:
                    # No preview published upstream: draw a schematic render from the geometry itself.
                    print(f"[thumb] {model['key']} <- schematic render of {target.name}")
                    thumbnail.write_bytes(render_thumbnail(data, thumbnail_width))
        model["sha256"] = sha256_of(data)
        model["bytes"] = len(data)
        model["extent"] = round(model_extent(glb_document(data)), 6)
        total_bytes += len(data)

    if args.verify:
        for line in problems:
            print("[problem]", line)
        print(f"verified {len(manifest['models'])} models, {total_bytes:,} bytes, {len(problems)} problem(s)")
        return 1 if problems else 0

    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_readme(manifest)
    print(f"done: {len(manifest['models'])} models, {total_bytes:,} bytes of GLB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
