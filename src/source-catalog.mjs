export const SOURCE_CATALOG = Object.freeze({
  planning: Object.freeze({
    family: "official-planning-documents",
    role: "primary-geometry-material-authority",
    requiredForPlanningCoverage: true,
    defaultFailOpen: false
  }),
  osm: Object.freeze({
    family: "openstreetmap-overpass",
    role: "placement-context-gap-fill",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  lidar: Object.freeze({
    family: "environment-agency-dtm-dsm-lidar",
    role: "terrain-elevation-structure-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "planning-data": Object.freeze({
    family: "planning-data-england",
    role: "trees-tpo-ancient-woodland-listed-buildings",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "national-trees-outside-woodland": Object.freeze({
    family: "national-trees-outside-woodland",
    role: "tree-canopy-height-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "microsoft-buildings": Object.freeze({
    family: "microsoft-global-ml-building-footprints",
    role: "confidence-gated-building-gap-fill",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "os-openmap-local": Object.freeze({
    family: "os-openmap-local",
    role: "supplemental-vector-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  wikidata: Object.freeze({
    family: "wikidata",
    role: "place-attraction-labels",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  wikimedia: Object.freeze({
    family: "wikimedia-commons",
    role: "geotagged-photo-licence-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  openaerialmap: Object.freeze({
    family: "openaerialmap",
    role: "open-aerial-imagery-discovery",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "ogc-features": Object.freeze({
    family: "ogc-api-features",
    role: "configured-supplemental-vector-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "arcgis-features": Object.freeze({
    family: "arcgis-feature-layer",
    role: "configured-supplemental-vector-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  geojson: Object.freeze({
    family: "remote-or-repository-geojson",
    role: "configured-supplemental-vector-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  }),
  "licensed-orthophoto": Object.freeze({
    family: "rights-cleared-georeferenced-orthophoto",
    role: "appearance-path-terrain-evidence",
    requiredForPlanningCoverage: false,
    defaultFailOpen: true
  })
});

export const REFERENCE_SOURCE_IDS = Object.freeze(Object.keys(SOURCE_CATALOG));
export const DEFAULT_FAIL_OPEN_SOURCE_IDS = Object.freeze(
  REFERENCE_SOURCE_IDS.filter((id) => SOURCE_CATALOG[id].defaultFailOpen)
);

export function assertReferenceSourceParity(sourceIds) {
  const available = new Set((sourceIds || []).map(String));
  const missing = REFERENCE_SOURCE_IDS.filter((id) => !available.has(id));
  return { complete: missing.length === 0, missing };
}
