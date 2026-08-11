#!/usr/bin/env python3
"""Project Gen native planning image registration/vector worker.

The hot kernels intentionally preserve the Voxel Mapping Engine Phase 30D rules:
- search within the existing 650 m application-location ROI when a prior exists;
- evaluate candidate quality only inside an 8 px padded transformed footprint;
- use a 4 px precision/recall proximity gate;
- keep up to 12 spatially distinct alternatives for cross-document consensus.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from typing import Any

import cv2
import numpy as np

EARTH_RADIUS_M = 6371008.8


def finite(value: Any, fallback: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def rejected(reason: str, **extra: Any) -> dict[str, Any]:
    return {"status": "rejected", "reason": reason, **extra}


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = a
    lon2, lat2 = b
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def bbox_values(bbox: Any) -> tuple[float, float, float, float] | None:
    if isinstance(bbox, dict):
        south = finite(bbox.get("south"))
        west = finite(bbox.get("west"))
        north = finite(bbox.get("north"))
        east = finite(bbox.get("east"))
    elif isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        south, west, north, east = (finite(value) for value in bbox)
    else:
        return None
    if None in (south, west, north, east) or not (south < north and west < east):
        return None
    return float(south), float(west), float(north), float(east)


def wgs84_to_reference(lon: float, lat: float, bbox: Any, width: int, height: int) -> tuple[float, float]:
    south, west, north, east = bbox_values(bbox) or (_ for _ in ()).throw(ValueError("invalid bbox"))
    x = (lon - west) / (east - west) * max(1, width - 1)
    y = (north - lat) / (north - south) * max(1, height - 1)
    return x, y


def reference_to_wgs84(x: float, y: float, bbox: Any, width: int, height: int) -> tuple[float, float]:
    south, west, north, east = bbox_values(bbox) or (_ for _ in ()).throw(ValueError("invalid bbox"))
    lon = west + x / max(1, width - 1) * (east - west)
    lat = north - y / max(1, height - 1) * (north - south)
    return lon, lat


def reference_metres_per_pixel(bbox: Any, width: int, height: int) -> tuple[float, float]:
    south, west, north, east = bbox_values(bbox) or (_ for _ in ()).throw(ValueError("invalid bbox"))
    mid_lat = (south + north) / 2
    mid_lon = (west + east) / 2
    metres_x = haversine_m((west, mid_lat), (east, mid_lat)) / max(1, width - 1)
    metres_y = haversine_m((mid_lon, south), (mid_lon, north)) / max(1, height - 1)
    return max(1e-6, metres_x), max(1e-6, metres_y)


def load_gray(path: str) -> np.ndarray:
    image = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"unable to read image: {path}")
    return image


def linework_edges(gray: np.ndarray) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 45, 145, apertureSize=3, L2gradient=True)
    return (edges > 0).astype(np.uint8)


def prepare_plan(image: np.ndarray):
    edges = linework_edges(image)
    ys, xs = np.where(edges > 0)
    if len(xs) < 80:
        return None
    padding = 10
    x0 = max(0, int(xs.min()) - padding)
    y0 = max(0, int(ys.min()) - padding)
    x1 = min(image.shape[1], int(xs.max()) + padding + 1)
    y1 = min(image.shape[0], int(ys.max()) + padding + 1)
    crop = edges[y0:y1, x0:x1]
    anchor = np.asarray([crop.shape[1] / 2.0, crop.shape[0] / 2.0], dtype=np.float64)
    return crop, (x0, y0), anchor, {"edgeCount": int(crop.sum()), "crop": [x0, y0, x1, y1]}


def transformed_template(crop_edges: np.ndarray, anchor: np.ndarray, scale: float, angle: float):
    h, w = crop_edges.shape
    base = cv2.getRotationMatrix2D((float(anchor[0]), float(anchor[1])), float(angle), float(scale))
    corners = np.asarray([[0.0, 0.0, 1.0], [w, 0.0, 1.0], [w, h, 1.0], [0.0, h, 1.0]], dtype=np.float64)
    projected = corners @ base.T
    min_x, min_y = projected[:, 0].min(), projected[:, 1].min()
    max_x, max_y = projected[:, 0].max(), projected[:, 1].max()
    out_w = int(math.ceil(max_x - min_x)) + 2
    out_h = int(math.ceil(max_y - min_y)) + 2
    if out_w < 4 or out_h < 4 or out_w > 10000 or out_h > 10000:
        return None, None, None
    matrix = base.copy()
    matrix[:, 2] += np.asarray([-min_x + 1, -min_y + 1], dtype=np.float64)
    template = cv2.warpAffine((crop_edges * 255).astype(np.uint8), matrix, (out_w, out_h), flags=cv2.INTER_AREA)
    template = (template > 22).astype(np.uint8)
    local_anchor = np.asarray([anchor[0], anchor[1], 1.0], dtype=np.float64) @ matrix.T
    return template, matrix, local_anchor


def reference_offset_metres(anchor_ref: np.ndarray, location: tuple[float, float] | None, bbox: Any, width: int, height: int) -> float | None:
    if location is None:
        return None
    lon, lat = reference_to_wgs84(float(anchor_ref[0]), float(anchor_ref[1]), bbox, width, height)
    return haversine_m((lon, lat), location)


def evaluate_candidate(crop_edges, matrix, reference, reference_distance, source_edges, bbox, crop_origin, image_shape, denominator, angle, location, anchor_ref):
    ref_h, ref_w = reference.shape
    source_h, source_w = crop_edges.shape
    corners = np.asarray([[0.0, 0.0, 1.0], [source_w, 0.0, 1.0], [source_w, source_h, 1.0], [0.0, source_h, 1.0]], dtype=np.float64)
    projected = corners @ matrix.T
    padding = 8
    x0 = max(0, int(math.floor(float(projected[:, 0].min()))) - padding)
    y0 = max(0, int(math.floor(float(projected[:, 1].min()))) - padding)
    x1 = min(ref_w, int(math.ceil(float(projected[:, 0].max()))) + padding)
    y1 = min(ref_h, int(math.ceil(float(projected[:, 1].max()))) + padding)
    if x1 <= x0 or y1 <= y0:
        return None

    local_matrix = matrix.copy()
    local_matrix[:, 2] -= np.asarray([x0, y0], dtype=np.float64)
    roi_w, roi_h = x1 - x0, y1 - y0
    warped = cv2.warpAffine(source_edges, local_matrix, (roi_w, roi_h), flags=cv2.INTER_AREA)
    plan = (warped > 22).astype(np.uint8)
    if int(plan.sum()) < 80:
        return None
    footprint = cv2.warpAffine(np.ones(crop_edges.shape, dtype=np.uint8), local_matrix, (roi_w, roi_h), flags=cv2.INTER_NEAREST)
    reference_roi = reference[y0:y1, x0:x1]
    reference_distance_roi = reference_distance[y0:y1, x0:x1]
    plan_distance = cv2.distanceTransform((1 - plan).astype(np.uint8), cv2.DIST_L2, 3)
    plan_pixels = plan > 0
    reference_pixels = (reference_roi > 0) & (footprint > 0)
    if int(reference_pixels.sum()) < 50:
        return None
    precision = float(np.mean(reference_distance_roi[plan_pixels] <= 4.0))
    recall = float(np.mean(plan_distance[reference_pixels] <= 4.0))
    f1 = 2 * precision * recall / max(1e-9, precision + recall)
    location_offset = reference_offset_metres(anchor_ref, location, bbox, ref_w, ref_h) if location is not None else None
    prior = 0.0 if location_offset is None else max(-0.06, 0.05 - location_offset / 10000.0)
    return {
        "score": f1 + prior, "f1": f1, "precision": precision, "recall": recall,
        "angleDeg": float(angle), "scaleDenominator": int(denominator),
        "anchorReference": [float(anchor_ref[0]), float(anchor_ref[1])],
        "matrix": matrix.tolist(), "edgeCount": int(plan.sum()),
        "referenceEdgeCount": int(reference_pixels.sum()),
        "locationOffsetM": float(location_offset) if location_offset is not None else None,
        "cropOrigin": [int(crop_origin[0]), int(crop_origin[1])],
        "sourceImageWidth": int(image_shape[1]), "sourceImageHeight": int(image_shape[0]),
    }


def search_registration(crop_edges, anchor, crop_origin, image_shape, bbox, reference, reference_distance, source_edges, dpi, denominator, angles, location):
    ref_h, ref_w = reference.shape
    metres_x, metres_y = reference_metres_per_pixel(bbox, ref_w, ref_h)
    reference_metres = (metres_x + metres_y) / 2.0
    plan_metres_per_pixel = denominator * 0.0254 / dpi
    scale = plan_metres_per_pixel / reference_metres
    if not 0.006 <= scale <= 4.0:
        return []

    results = []
    for angle in angles:
        template, local_matrix, local_anchor = transformed_template(crop_edges, anchor, scale, angle)
        if template is None:
            continue
        th, tw = template.shape
        if th >= ref_h or tw >= ref_w:
            continue
        edge_count = int(template.sum())
        if edge_count < 70:
            continue

        offset_left = 0
        offset_top = 0
        distance_input = reference_distance
        if location is not None:
            rows, cols = ref_h - th + 1, ref_w - tw + 1
            cx, cy = wgs84_to_reference(location[0], location[1], bbox, ref_w, ref_h)
            radius_x, radius_y = max(80, int(650 / metres_x)), max(80, int(650 / metres_y))
            left = max(0, int(cx - radius_x - tw / 2))
            right = min(cols, int(cx + radius_x - tw / 2))
            top = max(0, int(cy - radius_y - th / 2))
            bottom = min(rows, int(cy + radius_y - th / 2))
            if right <= left or bottom <= top:
                continue
            distance_input = reference_distance[top:bottom + th - 1, left:right + tw - 1]
            offset_left, offset_top = left, top

        cost = cv2.matchTemplate(distance_input, template.astype(np.float32), cv2.TM_CCORR) / max(1, edge_count)
        flat = cost.ravel()
        finite_count = int(np.isfinite(flat).sum())
        if not finite_count:
            continue
        take = min(8, finite_count)
        indices = np.argpartition(flat, take - 1)[:take]
        indices = indices[np.argsort(flat[indices])]
        used = []
        for index in indices:
            local_top, local_left = divmod(int(index), cost.shape[1])
            top, left = local_top + offset_top, local_left + offset_left
            anchor_ref = np.asarray([left + local_anchor[0], top + local_anchor[1]], dtype=np.float64)
            if any(np.linalg.norm(anchor_ref - prior) < 35 for prior in used):
                continue
            used.append(anchor_ref)
            matrix = local_matrix.copy()
            matrix[:, 2] += np.asarray([left, top], dtype=np.float64)
            candidate = evaluate_candidate(
                crop_edges, matrix, reference, reference_distance, source_edges, bbox, crop_origin, image_shape,
                denominator, angle, location, anchor_ref,
            )
            if candidate:
                results.append(candidate)
    return results


def distinct_candidate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    pa = np.asarray(a.get("anchorReference", [0, 0]), dtype=np.float64)
    pb = np.asarray(b.get("anchorReference", [0, 0]), dtype=np.float64)
    return float(np.linalg.norm(pa - pb)) >= 35.0


def confidence_score(candidate: dict[str, Any], supported: bool) -> float:
    f1 = max(0.0, min(1.0, float(candidate.get("f1", 0.0))))
    precision = max(0.0, min(1.0, float(candidate.get("precision", 0.0))))
    recall = max(0.0, min(1.0, float(candidate.get("recall", 0.0))))
    support = 0.03 if supported else 0.0
    return max(0.0, min(0.99, 0.6 * f1 + 0.2 * precision + 0.2 * recall + support))


def source_to_reference(candidate: dict[str, Any], x: float, y: float) -> tuple[float, float]:
    matrix = np.asarray(candidate["matrix"], dtype=np.float64)
    crop_x, crop_y = candidate.get("cropOrigin", [0, 0])
    local = np.asarray([x - crop_x, y - crop_y, 1.0], dtype=np.float64)
    ref = local @ matrix.T
    return float(ref[0]), float(ref[1])


def control_points(candidate: dict[str, Any], image_shape, bbox: Any, reference_size: tuple[int, int]) -> list[dict[str, float]]:
    height, width = int(image_shape[0]), int(image_shape[1])
    ref_w, ref_h = int(reference_size[0]), int(reference_size[1])
    samples = [
        (0.15 * width, 0.15 * height), (0.85 * width, 0.15 * height),
        (0.85 * width, 0.85 * height), (0.15 * width, 0.85 * height),
        (0.5 * width, 0.5 * height), (0.5 * width, 0.2 * height),
        (0.8 * width, 0.5 * height), (0.5 * width, 0.8 * height),
    ]
    points = []
    for x, y in samples:
        rx, ry = source_to_reference(candidate, x, y)
        if not (0 <= rx < ref_w and 0 <= ry < ref_h):
            continue
        lon, lat = reference_to_wgs84(rx, ry, bbox, ref_w, ref_h)
        points.append({"x": round(float(x), 3), "y": round(float(y), 3), "longitude": lon, "latitude": lat})
    return points


def control_center(points: list[dict[str, float]]) -> dict[str, float] | None:
    if not points:
        return None
    return {
        "longitude": sum(float(p["longitude"]) for p in points) / len(points),
        "latitude": sum(float(p["latitude"]) for p in points) / len(points),
    }


def compact_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    return {key: candidate.get(key) for key in ["score", "f1", "precision", "recall", "angleDeg", "scaleDenominator", "edgeCount", "referenceEdgeCount", "locationOffsetM"]}


def ranked_registration_alternatives(candidates, image_shape, bbox, reference_size, location):
    selected, raw = [], []
    for candidate in candidates:
        if any(not distinct_candidate(candidate, prior) for prior in raw):
            continue
        points = control_points(candidate, image_shape, bbox, reference_size)
        if len(points) < 5:
            continue
        supported = location is not None and (candidate.get("locationOffsetM") or float("inf")) <= 500
        raw.append(candidate)
        selected.append({
            "page": 1,
            "pageWidth": float(image_shape[1]),
            "pageHeight": float(image_shape[0]),
            "crs": "EPSG:4326",
            "points": points,
            "confidence": confidence_score(candidate, supported),
            "candidateLocation": control_center(points),
            "quality": compact_candidate(candidate),
            "alternativeRank": len(selected) + 1,
            "matrix": candidate.get("matrix"),
            "cropOrigin": candidate.get("cropOrigin"),
            "sourceImageWidth": candidate.get("sourceImageWidth"),
            "sourceImageHeight": candidate.get("sourceImageHeight"),
        })
        if len(selected) >= 12:
            break
    return selected


def parse_location(value: Any) -> tuple[float, float] | None:
    if not value:
        return None
    if isinstance(value, dict):
        lon = finite(value.get("longitude", value.get("lon", value.get("lng"))))
        lat = finite(value.get("latitude", value.get("lat")))
    elif isinstance(value, (list, tuple)) and len(value) >= 2:
        lon, lat = finite(value[0]), finite(value[1])
    else:
        return None
    if lon is None or lat is None:
        return None
    return float(lon), float(lat)


def register(request: dict[str, Any]) -> dict[str, Any]:
    bbox = request.get("bbox")
    if bbox_values(bbox) is None:
        return rejected("invalid-bbox")
    image = load_gray(str(request["imagePath"]))
    reference_gray = load_gray(str(request["referenceImagePath"]))
    reference = linework_edges(reference_gray)
    if int(reference.sum()) < 300:
        return rejected("reference-linework-too-sparse")
    reference_distance = cv2.distanceTransform((1 - reference).astype(np.uint8), cv2.DIST_L2, 3).astype(np.float32)

    prepared = prepare_plan(image)
    if not prepared:
        return rejected("planning-linework-too-sparse")
    crop_edges, crop_origin, anchor, preparation = prepared
    source_edges = cv2.dilate((crop_edges * 255).astype(np.uint8), np.ones((2, 2), np.uint8), iterations=1)

    dpi = finite(request.get("imageDpi"), 240.0) or 240.0
    denominators = [int(value) for value in request.get("scaleDenominators", []) if finite(value) and 25 <= float(value) <= 10000]
    if not denominators:
        denominators = [100, 200, 250, 500, 1000, 1250, 2000, 2500]
    denominators = list(dict.fromkeys(denominators))[:12]
    angles = [float(value) for value in request.get("angles", []) if finite(value) is not None]
    if not angles:
        angles = [-6, -3, 0, 3, 6, 90, 180, 270]
    angles = list(dict.fromkeys(angles))[:16]
    location = parse_location(request.get("locationPrior"))

    candidates = []
    for denominator in denominators:
        candidates.extend(search_registration(
            crop_edges, anchor, crop_origin, image.shape, bbox, reference,
            reference_distance, source_edges, dpi, denominator, angles, location,
        ))
    if not candidates:
        return rejected("no-visual-registration-candidate", preparation=preparation)
    candidates.sort(key=lambda item: (float(item.get("score", 0)), float(item.get("f1", 0)), float(item.get("precision", 0)), float(item.get("recall", 0))), reverse=True)
    alternatives = ranked_registration_alternatives(candidates, image.shape, bbox, (reference.shape[1], reference.shape[0]), location)
    if not alternatives:
        return rejected("automatic-control-point-generation-failed", preparation=preparation)
    best = alternatives[0]
    confidence = float(best["confidence"])
    status = "accepted" if confidence >= float(request.get("minConfidence", 0.72)) else "candidate"
    return {
        "status": status,
        "reason": None if status == "accepted" else "visual-registration-confidence-below-gate",
        "pageWidth": best["pageWidth"], "pageHeight": best["pageHeight"], "crs": "EPSG:4326",
        "points": best["points"], "confidence": confidence,
        "candidateLocation": best["candidateLocation"], "quality": best["quality"],
        "alternatives": alternatives[1:12],
        "matrix": best.get("matrix"), "cropOrigin": best.get("cropOrigin"),
        "sourceImageWidth": best.get("sourceImageWidth"), "sourceImageHeight": best.get("sourceImageHeight"),
        "preparation": preparation, "candidatesEvaluated": len(candidates),
    }


def candidate_page_to_wgs84(candidate: dict[str, Any], x: float, y: float, bbox: Any, ref_w: int, ref_h: int) -> tuple[float, float] | None:
    matrix = candidate.get("matrix")
    crop_origin = candidate.get("cropOrigin")
    if matrix and crop_origin:
        temp = {"matrix": matrix, "cropOrigin": crop_origin}
        rx, ry = source_to_reference(temp, x, y)
        if 0 <= rx < ref_w and 0 <= ry < ref_h:
            return reference_to_wgs84(rx, ry, bbox, ref_w, ref_h)
    points = candidate.get("points") or []
    if len(points) < 3:
        return None
    a = np.asarray([[float(p["x"]), float(p["y"]), 1.0] for p in points], dtype=np.float64)
    lon = np.asarray([float(p["longitude"]) for p in points], dtype=np.float64)
    lat = np.asarray([float(p["latitude"]) for p in points], dtype=np.float64)
    lon_coef = np.linalg.lstsq(a, lon, rcond=None)[0]
    lat_coef = np.linalg.lstsq(a, lat, rcond=None)[0]
    v = np.asarray([x, y, 1.0], dtype=np.float64)
    return float(v @ lon_coef), float(v @ lat_coef)


def anchor_distance_to_contour(anchor: dict[str, Any], contour: np.ndarray) -> float:
    bounds = anchor.get("bounds") or {}
    point = (finite(bounds.get("centerX"), 0.0) or 0.0, finite(bounds.get("centerY"), 0.0) or 0.0)
    return abs(float(cv2.pointPolygonTest(contour.astype(np.float32), point, True)))


def vectorize(request: dict[str, Any]) -> dict[str, Any]:
    image = load_gray(str(request["imagePath"]))
    bbox = request.get("bbox")
    candidate = request.get("candidate") or {}
    reference_path = request.get("referenceImagePath")
    if reference_path:
        ref = load_gray(str(reference_path))
        ref_h, ref_w = ref.shape
    else:
        ref_w, ref_h = 1600, 1600
    edges = linework_edges(image)
    connected = cv2.morphologyEx((edges * 255).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
    contours, _ = cv2.findContours(connected, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    anchors = (request.get("semantics") or {}).get("anchors") or []
    max_distance = float(request.get("semanticDistancePx", 120))
    vectors = []
    for contour in contours:
        if len(contour) < 12 or cv2.arcLength(contour, False) < 35:
            continue
        matches = sorted(
            ((anchor_distance_to_contour(anchor, contour), anchor) for anchor in anchors if anchor.get("role")),
            key=lambda item: (item[0], -float(item[1].get("confidence", 0))),
        )
        if not matches or matches[0][0] > max_distance:
            continue
        distance, anchor = matches[0]
        epsilon = max(1.5, 0.008 * cv2.arcLength(contour, False))
        simplified = cv2.approxPolyDP(contour, epsilon, False).reshape(-1, 2)
        if len(simplified) < 2:
            continue
        coordinates = []
        for px, py in simplified:
            point = candidate_page_to_wgs84(candidate, float(px), float(py), bbox, ref_w, ref_h)
            if point:
                coordinates.append([point[0], point[1]])
        if len(coordinates) < 2:
            continue
        role = str(anchor["role"])
        vectors.append({
            "role": role,
            "confidence": max(float(anchor.get("confidence", 0)), float(candidate.get("confidence", 0))),
            "geometry": {"type": "LineString", "coordinates": coordinates},
            "properties": {
                "planning_semantic": True,
                "planning_semantic_label": anchor.get("text"),
                "planning_semantic_distance_px": round(distance, 1),
            },
        })
    return {"vectors": vectors, "contours": len(contours), "semanticMatches": len(vectors)}


def self_test() -> None:
    ref = np.zeros((420, 420), dtype=np.uint8)
    cv2.rectangle(ref, (130, 120), (290, 300), 1, 2)
    cv2.line(ref, (145, 210), (275, 210), 1, 2)
    crop = np.zeros((180, 160), dtype=np.uint8)
    cv2.rectangle(crop, (0, 0), (159, 179), 1, 2)
    cv2.line(crop, (15, 90), (145, 90), 1, 2)
    bbox = {"south": 52.98, "west": -1.90, "north": 53.00, "east": -1.86}
    rd = cv2.distanceTransform((1 - ref).astype(np.uint8), cv2.DIST_L2, 3).astype(np.float32)
    source = cv2.dilate((crop * 255).astype(np.uint8), np.ones((2, 2), np.uint8), iterations=1)
    mx, my = reference_metres_per_pixel(bbox, 420, 420)
    denominator = int(round(((mx + my) / 2) * 240 / 0.0254))
    location = reference_to_wgs84(210, 210, bbox, 420, 420)
    found = search_registration(crop, np.asarray([80.0, 90.0]), (0, 0), crop.shape, bbox, ref, rd, source, 240, denominator, [0], location)
    if not found:
        raise RuntimeError("ROI registration self-test produced no candidate")
    best = sorted(found, key=lambda item: item["f1"], reverse=True)[0]
    if best["f1"] < 0.70:
        raise RuntimeError(f"ROI registration self-test weak F1={best['f1']:.3f}")
    print(json.dumps({"status": "ok", "f1": round(best["f1"], 4), "precision": round(best["precision"], 4), "recall": round(best["recall"], 4)}))


def read_request() -> dict[str, Any]:
    payload = sys.stdin.read()
    if not payload.strip():
        raise ValueError("JSON request required on stdin")
    value = json.loads(payload)
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["register", "vectorize", "self-test"])
    args = parser.parse_args()
    if args.mode == "self-test":
        self_test()
        return
    request = read_request()
    result = register(request) if args.mode == "register" else vectorize(request)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
