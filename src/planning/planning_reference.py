#!/usr/bin/env python3
from __future__ import annotations
import json, sys
from pathlib import Path
import cv2
import numpy as np


def bbox_values(bbox):
    if isinstance(bbox, dict):
        values = [bbox.get('south'), bbox.get('west'), bbox.get('north'), bbox.get('east')]
    elif isinstance(bbox, (list, tuple)) and len(bbox) == 4:
        values = list(bbox)
    else:
        raise ValueError('invalid bbox')
    south, west, north, east = map(float, values)
    if not south < north or not west < east:
        raise ValueError('invalid bbox extent')
    return south, west, north, east


def pixel(lon, lat, bbox, size):
    south, west, north, east = bbox_values(bbox)
    x = round((float(lon) - west) / (east - west) * (size - 1))
    y = round((north - float(lat)) / (north - south) * (size - 1))
    return int(x), int(y)


def element_geometries(element):
    geometry = element.get('geometry')
    if isinstance(geometry, list) and geometry:
        yield geometry
    for member in element.get('members') or []:
        geometry = member.get('geometry')
        if isinstance(geometry, list) and geometry:
            yield geometry


def relevant(tags):
    tags = tags or {}
    return any(key in tags for key in ['highway','building','barrier','natural','water','waterway','landuse','leisure','tourism','attraction','railway','man_made'])


def thickness(tags):
    tags = tags or {}
    if 'highway' in tags or 'railway' in tags:
        return 2
    if 'building' in tags or 'barrier' in tags:
        return 2
    return 1


def render(request):
    payload = request.get('payload') or {}
    bbox = request.get('bbox')
    size = max(256, min(4096, int(request.get('size') or 1600)))
    output = Path(request['outputPath'])
    output.parent.mkdir(parents=True, exist_ok=True)
    image = np.full((size, size), 255, dtype=np.uint8)
    features = 0
    segments = 0
    for element in payload.get('elements') or []:
        tags = element.get('tags') or {}
        if not relevant(tags):
            continue
        for geometry in element_geometries(element):
            points = []
            for point in geometry:
                lon = point.get('lon')
                lat = point.get('lat')
                if lon is None or lat is None:
                    continue
                x, y = pixel(lon, lat, bbox, size)
                if -32 <= x < size + 32 and -32 <= y < size + 32:
                    points.append([x, y])
            if len(points) < 2:
                continue
            array = np.asarray(points, dtype=np.int32).reshape((-1, 1, 2))
            closed = bool('building' in tags or tags.get('area') == 'yes' or 'water' in tags or tags.get('natural') == 'water')
            cv2.polylines(image, [array], closed, 0, thickness(tags), lineType=cv2.LINE_AA)
            features += 1
            segments += max(0, len(points) - 1)
    if features == 0:
        raise ValueError('reference source contains no drawable bounded linework')
    if not cv2.imwrite(str(output), image):
        raise RuntimeError('failed to write reference PNG')
    print(json.dumps({'status':'ok','outputPath':str(output),'width':size,'height':size,'features':features,'segments':segments}, separators=(',',':')))


def main():
    request = json.loads(sys.stdin.read())
    render(request)


if __name__ == '__main__':
    main()
