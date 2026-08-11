import { createHash } from "node:crypto";
import {
  normalizePlanningApplicationStatus,
  planningApplicationAuthorityReason,
  planningApplicationWorldAuthorityEligible
} from "./authority-status.mjs";

const ROLE_CLASS = Object.freeze({
  "site-path-centerline-candidate": "path",
  "site-road-centerline-candidate": "path",
  "ride-layout-candidate": "ride-layout",
  "ride-support-candidate": "ride-support",
  "building-footprint-candidate": "building",
  "wall-candidate": "wall",
  "barrier-candidate": "barrier",
  "fence-candidate": "fence",
  "water-candidate": "water",
  "rock-candidate": "rock",
  "terrain-detail-candidate": "terrain-detail"
});

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
}

function applicationAuthorityContext(value) {
  const provided = value !== null && value !== undefined && String(value).trim() !== "";
  if (!provided) {
    return {
      applicationStatus: null,
      worldAuthorityEligible: true,
      authorityStatusReason: "application-status-not-provided-legacy"
    };
  }
  const applicationStatus = normalizePlanningApplicationStatus(value);
  return {
    applicationStatus,
    worldAuthorityEligible: planningApplicationWorldAuthorityEligible(applicationStatus),
    authorityStatusReason: planningApplicationAuthorityReason(applicationStatus)
  };
}

export function featureClassForPlanningRole(role) {
  return ROLE_CLASS[String(role || "").trim().toLowerCase()] || null;
}

export function normalizePlanningVectors(vectors, context = {}) {
  const features = [];
  let withheld = 0;
  const withheldReasons = {};
  const authorityContext = applicationAuthorityContext(context.applicationStatus);
  for (const vector of vectors || []) {
    const role = String(vector?.role || vector?.properties?.planning_vector_role || "").trim().toLowerCase();
    const featureClass = featureClassForPlanningRole(role);
    if (!featureClass || !vector?.geometry) {
      withheld += 1;
      const reason = !featureClass ? "unsupported-planning-role" : "missing-geometry";
      withheldReasons[reason] = (withheldReasons[reason] || 0) + 1;
      continue;
    }
    const authorityKey = vector.authorityKey || `${featureClass}:${context.applicationReference || "unknown"}:${digest([role, vector.geometry])}`;
    features.push({
      type: "Feature",
      id: vector.id || authorityKey,
      geometry: vector.geometry,
      properties: {
        ...(vector.properties || {}),
        featureClass,
        authorityKey,
        source: "planning",
        confidence: Number(vector.confidence ?? context.confidence ?? 0),
        planning_vector_role: role,
        planning_geometry_authority: "planning-drawing",
        planning_surface_authority: ["path", "path-material"].includes(featureClass) ? "planning-drawing" : undefined,
        planningApplicationStatus: authorityContext.applicationStatus,
        planningWorldAuthorityEligible: authorityContext.worldAuthorityEligible,
        planningWorldAuthorityReason: authorityContext.authorityStatusReason,
        applicationReference: context.applicationReference || null,
        documentId: context.documentId || null,
        sourceSha256: context.sourceSha256 || null,
        page: context.page || null
      }
    });
  }
  return { features, withheld, withheldReasons, semanticMatches: features.length };
}
