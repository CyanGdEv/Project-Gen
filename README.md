# Project Gen

Project Gen is the high-throughput successor to **Voxel Mapping Engine**: a Minecraft Bedrock theme-park generator designed to recreate real parks at **1:1 scale** and deliver a directly importable `.mcworld` with a **five-minute generation target**.

## Core contract

- **Planning drawings are the ultimate truth** once they pass provenance, status, georeference-confidence, park-geofence and licensing gates.
- Planning is authoritative for ride layouts/supports, paths, path materials, buildings, walls/barriers/fences, water, rocks and other planning-visible site detail.
- OSM/Overpass remains useful as placement/context and gap-fill evidence, but it cannot override or repaint an accepted planning feature.
- Project Gen retains the same public source families as Voxel Mapping Engine while changing the execution architecture to remove repeated work.
- Performance optimisation must preserve output fidelity and evidence acceptance semantics.

## Performance direction

The engine is being built around four rules:

1. **Native source, no per-run patch assembly.** The production implementation lives directly in Project Gen.
2. **Content-addressed caching.** Planning documents, rendered pages, OCR/semantics, georeference transforms, terrain tiles and normalized evidence are reused when their inputs have not changed.
3. **Parallel task graph.** Independent source acquisition and processing stages run concurrently inside a hard 300-second deadline.
4. **Streaming world compilation.** Spatial chunks can compile as soon as their required evidence is resolved instead of waiting for unrelated park data.

## Current foundation

The first implementation phase contains:

- a deterministic planning-first authority resolver;
- hard planning locks that prevent OSM material/geometry leakage;
- a bounded parallel task graph;
- content-addressed artifact caching;
- an explicit five-minute phase budget;
- CI regression tests for authority, caching, concurrency and timing policy.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the source-parity plan, five-minute runtime design, and phased path to a full high-fidelity `.mcworld` generator.

## Reference

Fidelity reference: `CyanGdEv/Voxel-Mapping-Engine-`.

The initial Project Gen architecture was designed against the current Mapping Engine planning-authority and Phase 30D runtime work, including geometry-first planning selection, planning-over-OSM path/material authority, bounded registration ROIs and parallel consensus finalization.
