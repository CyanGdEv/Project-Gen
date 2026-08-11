# Project Gen

Project Gen is the high-throughput successor to **Voxel Mapping Engine**: a Minecraft Bedrock theme-park generator designed to recreate real parks at **1:1 scale** and deliver a directly importable `.mcworld` with a **five-minute generation target**.

## Generate Themepark in GitHub Actions

Project Gen is designed to run from **GitHub Actions**. No local terminal is required for the player-facing generation flow.

After the workflow is on the default branch:

1. Open **Actions**.
2. Select **Generate Themepark**.
3. Tap **Run workflow**.
4. Choose `alton-towers`, `chessington`, or `thorpe-park`.
5. Choose `benchmark` or `verified` accuracy.
6. Start the workflow.
7. Open the completed run summary and use the **Direct download** link.

The generated world is published as a raw `.mcworld` Release asset so it can be opened directly in Minecraft. The world is **not** nested inside an Actions artifact ZIP. Planning reports, authority GeoJSON and build diagnostics are uploaded separately.

For Alton Towers, the workflow runs Project Gen's planning-authority pipeline first and passes its accepted `planning-authority.geojson` to the Bedrock compiler. OSM remains registration/reference context and cannot replace planning-authoritative geometry or materials.

The current Bedrock packaging stage is an explicit, immutable bridge to `CyanGdEv/Voxel-Mapping-Engine-` commit `3564d8099f740ae6c1936053e90f765faca8f9b9`. Project Gen owns planning acquisition, validation, georeference and authority; the next compiler phase will replace this bridge with Project Gen's native streaming world compiler without changing the Actions UX.

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
6. **Streaming world compilation.** The native compiler layer will consume normalized authority features spatially rather than waiting for unrelated park data.

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

The native planning pass itself does not package Bedrock LevelDB yet. The **Generate Themepark** Action bridges that authority output into the pinned Bedrock compiler so end-to-end `.mcworld` generation can already be exercised through GitHub Actions while the native streaming compiler is built.

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
- native Poppler/Tesseract/OpenCV/GDAL tool availability in CI;
- final `.mcworld` archive integrity before direct release publication.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the source-parity plan, five-minute runtime design, and phased path to a full high-fidelity `.mcworld` generator.

## Reference

Fidelity reference: `CyanGdEv/Voxel-Mapping-Engine-`.

Project Gen is intentionally porting the reference engine's planning-authority and Phase 30D behavior into native, cacheable modules rather than copying its runtime patch-chain architecture.
