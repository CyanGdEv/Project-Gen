# Project Gen architecture

## Mission

Project Gen is a clean high-throughput successor to Voxel Mapping Engine. The target is to produce a directly importable Minecraft Bedrock `.mcworld` for a theme park at 1:1 scale in no more than 300 seconds while preserving the reference engine's fidelity and evidence rules.

The five-minute target is a performance contract to benchmark against, not a claim that the first implementation already meets it on every cold source request.

## Non-negotiable fidelity rules

1. Accepted, correctly georeferenced planning drawings are the highest geometry and appearance authority.
2. For ride layouts, ride supports, paths, path materials, buildings, walls/barriers/fences, water, rocks and terrain details, fallback sources cannot replace or repaint a planning-authoritative feature.
3. OSM/Overpass is fallback/context evidence. It can guide placement and fill gaps where planning evidence does not cover the object, but it cannot override accepted planning geometry or material evidence.
4. Planning evidence still has to pass provenance, application/status, georeference-confidence, park-geofence and licensing gates before becoming authoritative.
5. Optimisation must change execution cost, not acceptance thresholds or output fidelity.

## Source parity with Voxel Mapping Engine

Project Gen will retain adapters for the same source families used by the reference engine:

- official planning portal drawings and documents;
- OpenStreetMap / Overpass;
- Environment Agency DTM, DSM and LiDAR coverage;
- Planning Data datasets including trees, TPO areas, ancient woodland and listed buildings;
- National Trees Outside Woodland canopy and height evidence;
- Microsoft Global ML Building Footprints as confidence-gated gap fill;
- optional OS OpenMap Local;
- Wikidata place/attraction labels;
- Wikimedia Commons geotagged evidence;
- OpenAerialMap discovery;
- OGC API Features, ArcGIS Feature Layers and configured GeoJSON sources;
- rights-cleared georeferenced orthophotos.

## Why the new engine can be materially faster

Voxel Mapping Engine currently pays several costs in the interactive generation path that Project Gen should eliminate:

- runtime assembly of a locked generator plus a long ordered patch chain;
- repeated dependency installation on fresh runners;
- repeated planning-document rasterisation/georeferencing when source bytes have not changed;
- multi-platform planning discovery used as resilience rather than an internal transport fallback;
- source acquisition phases that can be overlapped;
- expensive planning image work over pixels outside the legal search region;
- late world compilation after long serial evidence stages.

Project Gen makes the prepared implementation native source code and uses content-addressed artifacts so unchanged evidence is never recomputed.

## Pipeline

### 1. Bootstrap and cache restore

Build an immutable request descriptor from park bounds, source configuration, engine version and quality profile. Restore cached artifacts by content hash, not by a mutable park name.

Cache independently:

- source responses and ETags;
- planning document bytes by SHA-256;
- rendered planning pages by document SHA + page + renderer version;
- OCR/semantic extraction by page hash + extractor version;
- georeference candidates and accepted transforms by page hash + reference hash + registration version;
- LiDAR/DTM/DSM tiles by upstream version/tile id;
- normalized vector evidence;
- compiled chunk payloads where all upstream evidence hashes match.

### 2. Concurrent source acquisition

Run independent providers concurrently under one bounded task graph. A source failure is recorded in provenance and follows the configured fail-open/fail-closed policy.

Planning portal transport fallbacks should occur inside one Linux acquisition task rather than launching three operating systems and selecting the best artifact after the fact.

### 3. Planning-first processing

Planning documents are classified geometry-first so site plans, block plans, GA/layout drawings and landscape/planting plans are processed before narrative documents.

Registration uses bounded legal ROIs and local candidate-footprint evaluation. Cross-document consensus is parallel and deterministic. Expensive stages are keyed by document/page hashes so a repeated park generation normally reuses the accepted transforms and extracted vectors.

### 4. Normalize once, fuse once

All providers emit one normalized feature contract containing at minimum:

- `featureClass`;
- `authorityKey`;
- `source`;
- `confidence`;
- provenance/licence references;
- geometry;
- appearance/material evidence when present.

`authorityKey` identifies competing representations of the same real-world slot. The hot fusion loop therefore does not redo expensive spatial matching.

Planning-locked feature classes are resolved before fallback enrichment. Metadata inheritance must have an explicit allow-list so OSM surface/material/width tags cannot leak back into a planning path.

### 5. Streaming world compilation

Compile spatial tiles/chunks as soon as their required evidence is ready rather than waiting for every unrelated park feature. Keep deterministic ordering for reproducibility while allowing worker-level parallel preparation.

The world writer should batch LevelDB operations and avoid per-block filesystem work. Packaging streams the final Bedrock world directly into `.mcworld` and validates required world entries before publication.

### 6. Direct download

Publish the player-facing `.mcworld` as a raw release/download asset. Diagnostics and provenance stay separate so the user never has to extract an Actions artifact ZIP to import the world.

## 300-second budget

The initial hard budget encoded in `src/budget.mjs` is:

| Phase | Maximum |
| --- | ---: |
| bootstrap/cache | 15 s |
| source acquisition | 65 s |
| planning processing | 80 s |
| fusion | 30 s |
| world compile | 75 s |
| validate/package | 25 s |
| reserve | 10 s |

The scheduler must fail with phase telemetry rather than silently extending this budget. Source acquisition and cache-hit planning work should overlap in the final runtime, so these are ceilings rather than a required serial schedule.

## Fidelity regression gate

Performance work is mergeable only when it passes both:

1. authority regressions proving planning remains the winner for planning-covered ride/path/material and other locked feature classes; and
2. reference-world comparisons against Voxel Mapping Engine for the same bounded evidence set.

The comparison should use normalized feature manifests and world/chunk statistics, not raw `.mcworld` byte equality, because archive metadata can differ while the generated world is equivalent.

## Delivery phases

### Phase A — core runtime

- planning-first authority resolver;
- bounded parallel task graph;
- content-addressed artifact cache;
- hard five-minute budget and telemetry;
- CI regression tests.

### Phase B — source adapters

Port the reference data sources into native adapters and remove per-run patch assembly. Start with planning, terrain/LiDAR and OSM because they control the largest geometry surfaces.

### Phase C — planning fast path

Port geometry-first document ranking, bounded ROI registration, semantic vector extraction and deterministic cross-document consensus. Persist accepted page transforms and extracted vectors by content hash.

### Phase D — world compiler

Port the current high-fidelity terrain/material/path/ride/building compilation into a streaming chunk compiler and preserve direct `.mcworld` output.

### Phase E — five-minute certification

Benchmark Alton Towers, Chessington and Thorpe Park on clean and warm caches. Treat any fidelity regression or >300 s run as a release blocker until the bottleneck is measured and resolved.
