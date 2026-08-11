import { createHash } from "node:crypto";

export const VME_PLANNING_BRIDGE_VERSION = 1;
export const PINNED_VME_COMPILER = Object.freeze({
  repository: "CyanGdEv/Voxel-Mapping-Engine-",
  sha: "3564d8099f740ae6c1936053e90f765faca8f9b9"
});

// These classes were consumed successfully by the pinned compiler before it
// reached Project Gen's newer terrain-detail class in the first real Alton run.
// Keep this list explicit: adding a class is a compiler-contract change, not a
// generic GeoJSON passthrough decision.
export const VME_PROVEN_PLANNING_CLASSES = Object.freeze([
  "barrier",
  "building",
  "fence",
  "path",
  "rock",
  "wall",
  "water"
]);

export const VME_KNOWN_WITHHELD_CLASSES = Object.freeze({
  "terrain-detail": "unsupported-by-pinned-vme-external-planning-contract"
});

function featureClass(feature) {
  const properties = feature?.properties || {};
  return String(properties.featureClass || properties.semanticClass || properties.class || "").trim().toLowerCase();
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function increment(target, key) {
  target[key] = Number(target[key] || 0) + 1;
}

function assertPlanningFeature(feature, index) {
  if (!feature || feature.type !== "Feature" || !feature.geometry) {
    throw new Error(`planning bridge input feature ${index} is not a GeoJSON Feature with geometry`);
  }
  const properties = feature.properties || {};
  if (String(properties.source || "").toLowerCase() !== "planning") {
    throw new Error(`planning bridge refuses non-planning feature ${feature.id || index}`);
  }
  if (properties.osmWorldRenderable === true) {
    throw new Error(`planning bridge refuses OSM-renderable feature ${feature.id || index}`);
  }
  if (properties.planningWorldAuthority !== true) {
    throw new Error(`planning bridge requires final planning-world authority for ${feature.id || index}`);
  }
}

export function bridgePlanningForPinnedVme(featureCollection, options = {}) {
  if (!featureCollection || featureCollection.type !== "FeatureCollection" || !Array.isArray(featureCollection.features)) {
    throw new Error("VME planning bridge input must be a GeoJSON FeatureCollection");
  }
  const allowed = new Set(options.allowedClasses || VME_PROVEN_PLANNING_CLASSES);
  const knownWithheld = { ...VME_KNOWN_WITHHELD_CLASSES, ...(options.knownWithheldClasses || {}) };
  const output = [];
  const withheld = [];
  const inputByClass = {};
  const outputByClass = {};
  const withheldByClass = {};

  for (let index = 0; index < featureCollection.features.length; index += 1) {
    const feature = featureCollection.features[index];
    assertPlanningFeature(feature, index);
    const klass = featureClass(feature);
    if (!klass) throw new Error(`planning bridge feature ${feature.id || index} is missing featureClass`);
    increment(inputByClass, klass);

    if (allowed.has(klass)) {
      // Deliberately preserve the exact accepted Project Gen feature object.
      // The bridge changes vocabulary coverage, never geometry/material/provenance.
      output.push(feature);
      increment(outputByClass, klass);
      continue;
    }

    const reason = knownWithheld[klass];
    if (!reason) {
      throw new Error(`unreviewed planning semantic class for pinned VME compiler: ${klass}`);
    }
    withheld.push({
      id: feature.id || null,
      featureClass: klass,
      reason,
      authorityKey: feature.properties?.authorityKey || null,
      applicationReference: feature.properties?.applicationReference || null,
      documentId: feature.properties?.documentId || null,
      sourceSha256: feature.properties?.sourceSha256 || null,
      page: feature.properties?.page ?? null
    });
    increment(withheldByClass, klass);
  }

  if (featureCollection.features.length > 0 && output.length === 0) {
    throw new Error("VME planning bridge withheld every planning feature");
  }

  const bridged = {
    ...featureCollection,
    features: output
  };
  const report = {
    schemaVersion: 1,
    bridgeVersion: VME_PLANNING_BRIDGE_VERSION,
    compiler: { ...PINNED_VME_COMPILER },
    mode: "loss-aware-pinned-compiler-compatibility",
    planningAuthorityPreserved: true,
    osmWorldRenderable: false,
    inputFeatures: featureCollection.features.length,
    outputFeatures: output.length,
    withheldFeatures: withheld.length,
    inputByClass,
    outputByClass,
    withheldByClass,
    inputSha256: stableHash(featureCollection),
    outputSha256: stableHash(bridged),
    withheld
  };
  return { featureCollection: bridged, report };
}
