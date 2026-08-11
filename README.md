# Project Gen

Project Gen is the high-throughput successor to **Voxel Mapping Engine**: a Minecraft Bedrock theme-park generator designed to recreate real parks at **1:1 scale** and deliver a directly importable `.mcworld` with a **five-minute generation target**.

## Core contract

- **Planning drawings are the ultimate truth** once they pass provenance, status, georeference-confidence, park-geofence and licensing gates.
- Planning is authoritative for ride layouts/supports, paths, path materials, buildings, walls/barriers/fences, water, rocks and other planning-visible site detail.
- OSM/Overpass is placement, registration-context and gap-fill evidence. It cannot override or repaint a planning-authoritative feature.
- Project Gen retains the same public source families as Voxel Mapping Engine while changing the execution architecture to remove repeated work.
- Performance optimisation must preserve output fidelity and evidence acceptance semantics.

## Performance architecture

1. **Native source, no per-run patch assembly.** The production implementation lives directly in Project Gen.
2. **Content-addressed caching.** Planning documents, page renders, OCR/semantics, georeferences, reference rasters and vectors are independently reusable.
3. **Strong evidence before heuristics.** Georeference priority is embedded geospatial metadata → explicit controls → printed coordinate/grid controls → OpenCV visual registration.
4. **Lazy visual matching.** OSM reference raster generation and OpenCV are skipped entirely when stronger georeference evidence already resolves a drawing.
5. **Bounded parallel execution.** Expensive independent work runs concurrently inside the 300-second generation contract.
6. **Streaming world compilation.** The next compiler layer will consume normalized authority features spatially rather than waiting for unrelated park data.

## Native planning pass

The current branch can execute the planning-authority stage end to end from a selected Voxel Mapping Engine planning-prefetch directory.

Native dependencies:

- Node.js 22+
- Poppler (`pdftoppm`, `pdfinfo`)
- Tesseract OCR
- Python 3 + OpenCV
- GDAL (`gdalinfo`, `gdaltransform`)

Run:

```bash
npm run planning:run -- \
  --planning-dir planning-prefetch-selected \
  --bbox 52.9810,-1.8970,52.9960,-1.8690
```

The runner:

1. validates the selected planning-prefetch manifest and document hashes;
2. ranks geometry-bearing planning drawings ahead of narrative evidence;
3. resolves safe local document paths and bounded PDF pages;
4. rasterises and OCRs only cache misses;
5. accepts embedded/explicit/printed-coordinate georeferences directly when valid;
6. only if needed, builds a cached bounded OSM reference marked `registration-context-only` and runs the Phase-30D-style OpenCV ROI matcher;
7. applies cross-document visual consensus only to heuristic registrations;
8. outputs planning-authoritative normalized vectors.

Outputs in `project-gen-planning-output/`:

- `planning-authority.geojson` — accepted planning-authoritative features;
- `planning-pass-report.json` — source/cache/georeference counts and wall-clock timing against the 300-second target.

The planning pass does **not** yet compile a Bedrock world. The next layer is the streaming terrain/material/world compiler that consumes this authority output plus terrain and uncovered fallback evidence.

## Fidelity protections

Current regression gates cover:

- planning-over-OSM geometry authority;
- planning material lockout;
- Mapping Engine-compatible visual-consensus thresholds;
- independently cached render/OCR/georeference/vector stages;
- direct strong georeference bypass of visual consensus;
- lazy OSM/OpenCV fallback;
- bounded 650 m registration search ROI and local candidate evaluation;
- OCR semantic roles for paths, ride layouts/supports, buildings, boundaries, water, rocks and terrain detail;
- native Poppler/Tesseract/OpenCV/GDAL tool availability in CI.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the source-parity plan, five-minute runtime design, and phased path to a full high-fidelity `.mcworld` generator.

## Reference

Fidelity reference: `CyanGdEv/Voxel-Mapping-Engine-`.

Project Gen is intentionally porting the reference engine's planning-authority and Phase 30D behavior into native, cacheable modules rather than copying its runtime patch-chain architecture.
