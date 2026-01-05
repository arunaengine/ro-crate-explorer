<script setup lang="ts">
import RoCrateEntity from "@/components/custom-ui/RoCrateEntity.vue";
import FileTreeItem from "@/components/custom-ui/FileTreeItem.vue";
import { ROCrate } from "ro-crate";
import { onMounted, onUnmounted, ref, computed, watch } from "vue";
import { Button } from "@/components/ui/button";
import { fetchCrateFromUrl, loadCrateFromFile } from '@/services/crateLoader';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import arunaBg from "@/assets/aruna-background.jpeg";

import * as jsonld from "jsonld";
import { config } from "@/config";
import { buildSearchIndex, localSearch, clearSearchIndex, addToIndex } from "@/services/searchService";

const INDEXING_SERVICE_BASE_URL = config.indexingServiceUrl;

interface TreeNode {
  name: string;
  id: string;
  type: string;
  children: TreeNode[];
  data: any;
}

interface HistoryItem {
  name: string;
  url: string | null;
}

interface CrateSummary {
  primary_crate: {
    crate_id: string;
    entity_count: number;
    is_subcrate: boolean;
  };
  subcrates: Array<{
    crate_id: string;
    entity_count: number;
    is_subcrate: boolean;
  }>;
  total_crates_added: number;
}

// State
const inputUrl = ref<string>(
  "https://rocrate.s3.computational.bio.uni-giessen.de/ro-crate-metadata.json"
);
const currentUrl = ref<string | null>(null);
const crate = ref<ROCrate | undefined>(undefined);
const currentCrateName = ref<string>("Root");
const pastedCrateText = ref<string>("");

const historyStack = ref<HistoryItem[]>([]);
const allEntities = ref<Array<any>>([]);

const expandedCrate = ref<any[]>([]);
const linkedDataHints = ref<Record<string, Record<string, { propIri?: string; valueIris: string[] }>>>(
  {}
);
// Selection State
const selectedEntityId = ref<string>("./");
const selectedEntityData = ref<{
  id: string;
  type: string;
  otherProps: Array<string>;
} | null>(null);

// Crate cache: stores fully processed crate data by URL for instant navigation
interface CachedCrate {
  json: any;
  entities: any[];
  expandedCrate: any[];
  linkedDataHints: Record<string, Record<string, { propIri?: string; valueIris: string[] }>>;
  crateName: string;
}
const crateCache = new Map<string, CachedCrate>();

// Root crate URL - the first crate loaded, used for breadcrumb hierarchy
const rootCrateUrl = ref<string | null>(null);

// UI State
const isDetailOverlayOpen = ref(false);
const linkedEntityData = ref<any>(null);
const fullCrateJson = ref<string | null>(null);
const isLoading = ref(false);
const baseUrl = ref<string>("");
const errorMsg = ref<string | null>(null);
const shareStatus = ref<string | null>(null);
const shareError = ref<string | null>(null);
const shareToastMessage = ref<string | null>(null);
const shareToastIsError = ref(false);
const shareToastVisible = ref(false);
let shareToastTimeout: ReturnType<typeof setTimeout> | null = null;

const SHARE_URL_LIMIT = 8000;

// Computed property to check if crate is too large to share
const isCrateTooLargeToShare = computed(() => {
  if (!fullCrateJson.value) return false;
  // Estimate URL length: base URL + "?crate=" + JSON content
  // Use a conservative estimate for the base URL overhead
  const estimatedLength = 100 + fullCrateJson.value.length;
  return estimatedLength > SHARE_URL_LIMIT;
});

// --- Search State ---
const isSearchOverlayOpen = ref(false);
const searchInput = ref<string>("");
// Store both entityId and crateId for each search result
const searchResults = ref<Array<{ entityId: string; crateId: string }>>([]);
const isSearching = ref(false);
const searchErrorMsg = ref<string | null>(null);
// Track if a search has ever been performed in the current session
const hasSearched = ref(false);
// --------------------

// MODIFIED: Context Filter State to use a string for input
const contextFilterInput = ref<string>("");

// Theme State
const isDark = ref(true);

const toggleTheme = () => {
  isDark.value = !isDark.value;
  if (isDark.value) {
    document.documentElement.classList.add("dark");
    localStorage.setItem("theme", "dark");
  } else {
    document.documentElement.classList.remove("dark");
    localStorage.setItem("theme", "light");
  }
};

// --- Helper: Name Extraction ---
const getSafeName = (entity: any, fallback: string) => {
  if (!entity) return fallback;

  let name = entity.name;
  if (Array.isArray(name) && name.length > 0) {
    name = name[0];
  }

  if (name && typeof name === "string") return name;

  if (entity["@id"]) return entity["@id"];

  return fallback;
};

// --- Helper: File Tree Generation (Graph Based) ---
const fileTree = computed(() => {
  let rootEntity =
    crate.value?.rootDataset ||
    allEntities.value.find((e) => e["@id"] === "./" || e["@id"] === ".");

  if (!rootEntity) {
    return {
      name: currentCrateName.value,
      id: "./",
      type: "Dataset",
      children: [],
      data: null,
    };
  }

  const entityMap = new Map<string, any>();
  allEntities.value.forEach((entity) => {
    entityMap.set(entity["@id"], entity);
  });

  const getNodeName = (entity: any, id: string) => {
    if (entity && entity.name) return entity.name;
    const parts = id.split("/").filter((p) => p && p !== ".");
    return parts[parts.length - 1] || id;
  };

  const buildTree = (entityId: string, visited: Set<string>): TreeNode => {
    const entity = entityMap.get(entityId);

    // Safety check: Loop detection
    if (visited.has(entityId)) {
      return {
        name: getNodeName(entity, entityId) + " (Link)",
        id: entityId,
        type: "Link",
        children: [],
        data: entity,
      };
    }

    const currentVisited = new Set(visited);
    currentVisited.add(entityId);

    const children: TreeNode[] = [];

    if (entity && entity.hasPart) {
      const parts = Array.isArray(entity.hasPart) ? entity.hasPart : [entity.hasPart];

      parts.forEach((part: any) => {
        const partId = part["@id"] ? part["@id"] : part;
        if (typeof partId === "string") {
          children.push(buildTree(partId, currentVisited));
        }
      });
    }

    children.sort((a, b) => {
      const aIsFolder = a.type === "Dataset";
      const bIsFolder = b.type === "Dataset";

      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    let typeStr = "File"; // Default
    if (entity && entity["@type"]) {
      typeStr = Array.isArray(entity["@type"]) ? entity["@type"][0] : entity["@type"];
    } else if (!entity) {
      typeStr = "Broken Link";
    }

    return {
      name: getNodeName(entity, entityId),
      id: entityId,
      type: typeStr,
      children: children,
      data: entity || null,
    };
  };

  return buildTree(rootEntity["@id"], new Set());
});

const otherEntitiesGroups = computed(() => {
  const groups: Record<string, any[]> = {};
  const filterText = contextFilterInput.value.trim().toLowerCase();

  allEntities.value.forEach((entity) => {
    const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
    const isTreeItem = types.includes("File") || types.includes("Dataset");
    if (!isTreeItem) {
      const mainType = types[0] || "Unknown";
      if (!groups[mainType]) groups[mainType] = [];
      groups[mainType].push(entity);
    }
  });

  const filteredGroups: Record<string, any[]> = {};
  for (const groupName in groups) {
    if (!filterText || groupName.toLowerCase().includes(filterText)) {
      filteredGroups[groupName] = groups[groupName] ?? [];
    }
  }

  return filteredGroups;
});

const contextEntityTypes = computed(() => {
  const types = new Set<string>();
  allEntities.value.forEach((entity) => {
    const entityTypes = Array.isArray(entity["@type"])
      ? entity["@type"]
      : [entity["@type"]];
    const isTreeItem = entityTypes.includes("File") || entityTypes.includes("Dataset");
    if (!isTreeItem) {
      const mainType = entityTypes[0] || "Unknown";
      types.add(mainType);
    }
  });
  return ["All", ...Array.from(types).sort()];
});

// --- Logic: Data Processing ---
const extractEntityData = (entity: any) => {
  if (!entity) return null;
  const { "@id": id, "@type": type, ...properties } = entity;
  const otherProps = Object.entries(properties).map(([key, value]) => {
    const isComplex = typeof value === "object" && value !== null;
    const displayValue = isComplex ? JSON.stringify(value, null, 2) : String(value);
    return `${key}:\n${displayValue}`;
  });
  return { id, type: Array.isArray(type) ? type.join(", ") : type, otherProps };
};

// Build a lookup of expanded property IRIs and value IRIs once per crate
const buildLinkedDataHints = async (json: any, expandedNodes: any[]) => {
  const context = json["@context"];
  if (!context) return {};

  const propertyCache = new Map<string, string | undefined>();

  const expandProperty = async (propName: string) => {
    if (propertyCache.has(propName)) return propertyCache.get(propName);
    try {
      const expanded = await jsonld.expand({ "@context": context, [propName]: "x" });
      const node = expanded?.[0] || {};
      const iri = Object.keys(node).find((k) => !k.startsWith("@"));
      propertyCache.set(propName, iri);
      return iri;
    } catch (e) {
      propertyCache.set(propName, undefined);
      return undefined;
    }
  };

  const hints: Record<string, Record<string, { propIri?: string; valueIris: string[] }>> = {};

  for (const entity of json["@graph"] || []) {
    const expandedNode = expandedNodes.find((n) => n["@id"] === entity["@id"]) || {};
    const props = Object.keys(entity).filter((k) => k !== "@id" && k !== "@type");

    const entries = await Promise.all(
      props.map(async (propName) => {
        const propIri = await expandProperty(propName);
        const values =
          propIri && Array.isArray(expandedNode[propIri])
            ? expandedNode[propIri]
                .map((v: any) => (v && typeof v === "object" ? v["@id"] : null))
                .filter((x: any): x is string => typeof x === "string")
            : [];
        return [propName, { propIri, valueIris: values }];
      })
    );

    hints[entity["@id"]] = Object.fromEntries(entries);
  }

  return hints;
};

const updateSelectedEntityView = () => {
  let entity = allEntities.value.find((e) => e["@id"] === selectedEntityId.value);
  if (!entity && (selectedEntityId.value === "./" || selectedEntityId.value === ".")) {
    entity =
      crate.value?.rootDataset ||
      allEntities.value.find((e) => e["@id"] === "./" || e["@id"] === ".");
  }
  if (entity) {
    selectedEntityData.value = extractEntityData(entity);
  } else {
    selectedEntityData.value = null;
  }
};

// Normalize RO-Crate JSON to use standard descriptor name
// The ro-crate library expects "@id": "ro-crate-metadata.json" but some crates
// use custom names like "proteomics-ro-crate-metadata.json"
const normalizeDescriptorName = (json: any): any => {
  if (!json || !json["@graph"]) return json;

  const graph = json["@graph"];
  const descriptorIndex = graph.findIndex((entity: any) => {
    // Find the descriptor: a CreativeWork that conformsTo RO-Crate spec and has about pointing to root
    if (entity["@type"] !== "CreativeWork") return false;
    const conformsTo = entity["conformsTo"];
    const conformsToId = conformsTo?.["@id"] || conformsTo;
    if (!conformsToId || !String(conformsToId).includes("ro/crate")) return false;
    const about = entity["about"];
    const aboutId = about?.["@id"] || about;
    return aboutId === "./" || aboutId === ".";
  });

  if (descriptorIndex === -1) return json;

  const descriptor = graph[descriptorIndex];
  // If already standard name, no change needed
  if (descriptor["@id"] === "ro-crate-metadata.json") return json;

  // Create a new graph with normalized descriptor name
  const newGraph = [...graph];
  newGraph[descriptorIndex] = {
    ...descriptor,
    "@id": "ro-crate-metadata.json"
  };

  return {
    ...json,
    "@graph": newGraph
  };
};

const processCrateData = async (
  json: any,
  sourceName: string,
  sourceUrl: string | null = null,
  isFirstCrate: boolean = false
) => {
  try {
    // Track root crate URL for breadcrumb hierarchy
    if (isFirstCrate && sourceUrl) {
      rootCrateUrl.value = sourceUrl;
    }

    // Check if we have fully processed cached data
    const cachedData = sourceUrl ? crateCache.get(sourceUrl) : null;
    if (cachedData && cachedData.expandedCrate) {
      // Use cached processed data - instant restore
      allEntities.value = cachedData.entities;
      expandedCrate.value = cachedData.expandedCrate;
      linkedDataHints.value = cachedData.linkedDataHints;
      currentCrateName.value = cachedData.crateName;
      fullCrateJson.value = JSON.stringify(cachedData.json, null, 2);
      currentUrl.value = sourceUrl;

      // Normalize and create ROCrate instance (lightweight)
      const normalizedJson = normalizeDescriptorName(cachedData.json);
      crate.value = new ROCrate(normalizedJson, { array: true, link: true });

      // Update search index
      const crateId = sourceUrl || 'primary';
      if (isFirstCrate) {
        buildSearchIndex(allEntities.value, crateId);
      } else {
        addToIndex(allEntities.value, crateId);
      }

      selectedEntityId.value = "./";
      updateSelectedEntityView();

      // Update breadcrumbs based on crate hierarchy
      updateBreadcrumbsForCrate(sourceUrl);
      return;
    }

    // Process new crate data
    allEntities.value = [];
    selectedEntityId.value = "./";
    selectedEntityData.value = null;

    // Normalize descriptor name for ro-crate library compatibility
    const normalizedJson = normalizeDescriptorName(json);
    crate.value = new ROCrate(normalizedJson, { array: true, link: true });

    allEntities.value = json["@graph"] || [];
    fullCrateJson.value = JSON.stringify(json, null, 2);
    currentUrl.value = sourceUrl;

    // Build or add to search index
    const crateId = sourceUrl || 'primary';
    if (isFirstCrate) {
      buildSearchIndex(allEntities.value, crateId);
    } else {
      addToIndex(allEntities.value, crateId);
    }

    let expanded: any[] = [];
    let hints: Record<string, Record<string, { propIri?: string; valueIris: string[] }>> = {};

    try {
      expanded = await jsonld.expand(json);
      expandedCrate.value = expanded;

      // Precompute linked-data hints (property/value IRIs) once per crate
      hints = await buildLinkedDataHints(json, expanded);
      linkedDataHints.value = hints;
    } catch (e) {
      console.error("Expansion failed:", e);
      expandedCrate.value = [];
      linkedDataHints.value = {};
    }

    const rootEntity =
      allEntities.value.find((e) => e["@id"] === "./" || e["@id"] === ".") ||
      crate.value?.rootDataset;
    currentCrateName.value = getSafeName(rootEntity, sourceName);

    // Cache the fully processed crate data
    if (sourceUrl) {
      crateCache.set(sourceUrl, {
        json,
        entities: allEntities.value,
        expandedCrate: expanded,
        linkedDataHints: hints,
        crateName: currentCrateName.value
      });
    }

    updateSelectedEntityView();

    // Update breadcrumbs based on crate hierarchy
    updateBreadcrumbsForCrate(sourceUrl);
  } catch (e: any) {
    errorMsg.value = "Failed to process RO-Crate JSON: " + e.message;
  }
};

// Update breadcrumbs - only clears when at root crate, otherwise preserves navigation history
const updateBreadcrumbsForCrate = (crateUrl: string | null) => {
  // If no URL or no root crate set, clear breadcrumbs (fresh start)
  if (!crateUrl || !rootCrateUrl.value) {
    historyStack.value = [];
    return;
  }

  // If we're at the root crate, clear breadcrumbs (we're at the top)
  if (crateUrl === rootCrateUrl.value) {
    historyStack.value = [];
    return;
  }

  // Otherwise, preserve the existing history stack - it's managed by handleSubcrateOpen
  // and goBack/goToBreadcrumb functions
};

const fetchMetadata = async (
  crateId: string,
  sourceName: string,
  sourceUrl: string | null = null,
  isFirstCrate: boolean = false
) => {
  try {
    let apiCrateId = crateId.endsWith("/") ? crateId.slice(0, -1) : crateId;

    const metadataEndpoint = `${INDEXING_SERVICE_BASE_URL}/crates/${encodeURIComponent(
      apiCrateId
    )}`;

    console.log(`Fetching ${sourceName} from ${metadataEndpoint}`);

    const response = await fetch(metadataEndpoint);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Error fetching metadata (${response.status}): ${errText}`);
    }

    const metadataJson = await response.json();
    console.log("Fetched Metadata: ", metadataJson);
    processCrateData(metadataJson, sourceName, sourceUrl, isFirstCrate);
  } catch (e: any) {
    throw new Error(`Metadata fetch failed: ${e.message}`);
  }
};

const loadFromUrl = async () => {
  if (!inputUrl.value) return;
  errorMsg.value = null;

  // Determine if this is the first crate load (no root crate set yet)
  const isFirstCrate = rootCrateUrl.value === null;
  const fetchUrl = inputUrl.value;

  // Check cache first for faster navigation (no loading screen needed)
  const cachedCrate = crateCache.get(fetchUrl);
  if (cachedCrate && cachedCrate.json) {
    console.log("Using cached crate for:", fetchUrl);

    // Set baseUrl for subcrate navigation
    try {
      const urlObj = new URL(fetchUrl);
      urlObj.pathname = urlObj.pathname.endsWith("/")
        ? urlObj.pathname
        : urlObj.pathname + "/";
      baseUrl.value = urlObj.href;
    } catch (e) {
      baseUrl.value = fetchUrl.endsWith("/") ? fetchUrl : fetchUrl + "/";
    }

    await processCrateData(cachedCrate.json, "Remote Crate (Cached)", fetchUrl, isFirstCrate);
    return;
  }

  // Only show loading for non-cached fetches
  isLoading.value = true;

  try {

    // Stateless mode: fetch directly without indexing service
    if (config.isStateless) {
      const json = await fetchCrateFromUrl(fetchUrl);
      fullCrateJson.value = JSON.stringify(json, null, 2);
      currentUrl.value = fetchUrl;

      // Set baseUrl for subcrate navigation
      try {
        const urlObj = new URL(fetchUrl);
        urlObj.pathname = urlObj.pathname.endsWith("/")
          ? urlObj.pathname
          : urlObj.pathname + "/";
        baseUrl.value = urlObj.href;
      } catch (e) {
        baseUrl.value = fetchUrl.endsWith("/") ? fetchUrl : fetchUrl + "/";
      }

      await processCrateData(json, "Remote Crate", fetchUrl, isFirstCrate);
      return;
    }

    // Stateful mode: use indexing service
    const summaryResponse = await fetch(`${INDEXING_SERVICE_BASE_URL}/crates/url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: fetchUrl }),
    });

    if (!summaryResponse.ok) {
      const errText = await summaryResponse.text();
      if (summaryResponse.status === 409) {
        let crateIdToFetch = null;
        try {
          const errorJson = JSON.parse(errText);
          const match = errorJson.error.match(/Crate already indexed: (.+)$/i);
          if (match && match[1]) {
            crateIdToFetch = match[1];
          }
        } catch (parseError) {
          console.warn(
            "Could not parse 409 error response to extract Crate ID:",
            parseError
          );
        }

        if (crateIdToFetch) {
          console.info(
            `Crate already indexed (${crateIdToFetch}). Skipping indexing and attempting to fetch metadata directly.`
          );

          let crateId = crateIdToFetch;
          try {
            const urlObj = new URL(crateId);
            urlObj.pathname = urlObj.pathname.endsWith("/")
              ? urlObj.pathname
              : urlObj.pathname + "/";
            baseUrl.value = urlObj.href;
          } catch (e) {
            // Fallback if crateId isn't a clean URL (e.g., local ID)
            baseUrl.value = crateId.endsWith("/") ? crateId : crateId + "/";
          }

          await fetchMetadata(crateId, "Remote Crate (Indexed)", fetchUrl, isFirstCrate);
          return;
        }
      }
      // Re-throw if it's a different error or the 409 couldn't be handled
      throw new Error(`Server Error (${summaryResponse.status}): ${errText}`);
    }

    const summary: CrateSummary = await summaryResponse.json();

    // Determine Base URL for subcrate navigation logic
    let crateId = summary.primary_crate.crate_id;
    try {
      const urlObj = new URL(crateId);
      urlObj.pathname = urlObj.pathname.endsWith("/")
        ? urlObj.pathname
        : urlObj.pathname + "/";
      baseUrl.value = urlObj.href;
    } catch (e) {
      // Fallback if crateId isn't a clean URL (e.g., local ID)
      baseUrl.value = crateId.endsWith("/") ? crateId : crateId + "/";
    }

    // 2. Fetch the actual metadata JSON-LD
    await fetchMetadata(crateId, "Remote Crate", fetchUrl, isFirstCrate);
  } catch (e: any) {
    errorMsg.value = `Error loading URL: ${e.message}`;
  } finally {
    isLoading.value = false;
  }
};

const loadFromPastedJson = async () => {
  if (!pastedCrateText.value.trim()) return;
  isLoading.value = true;
  errorMsg.value = null;
  baseUrl.value = "";

  try {
    const parsed = JSON.parse(pastedCrateText.value);
    // Pasted crate is always a fresh start
    processCrateData(parsed, "Pasted Crate", null, true);
  } catch (e: any) {
    errorMsg.value = `Paste error: ${e.message || e}`;
  } finally {
    isLoading.value = false;
  }
};

const handleFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement | null;
  const files = target?.files;
  if (!files || files.length === 0) return;
  const file = files.item(0);
  if (!file) return;

  isLoading.value = true;
  errorMsg.value = null;
  baseUrl.value = "";

  try {
    // Stateless mode: load file directly without indexing service
    if (config.isStateless) {
      const json = await loadCrateFromFile(file);
      fullCrateJson.value = JSON.stringify(json, null, 2);
      currentUrl.value = file.name;

      // File upload is always a fresh start
      await processCrateData(json, file.name, null, true);
      return;
    }

    // Stateful mode: use indexing service
    const formData = new FormData();
    formData.append("file", file);

    const summaryResponse = await fetch(`${INDEXING_SERVICE_BASE_URL}/crates/upload`, {
      method: "POST",
      body: formData,
    });

    if (!summaryResponse.ok) {
      const errText = await summaryResponse.text();
      throw new Error(`Server Error (${summaryResponse.status}): ${errText}`);
    }

    const summary: CrateSummary = await summaryResponse.json();

    let crateId = summary.primary_crate.crate_id;
    baseUrl.value = crateId.endsWith("/") ? crateId : crateId + "/";

    // File upload is always a fresh start
    await fetchMetadata(crateId, file.name, null, true);
  } catch (e: any) {
    errorMsg.value = `File error: ${e.message}`;
  } finally {
    isLoading.value = false;
    if (target) {
      target.value = "";
    }
  }
};

// --- Logic: Search ---
const runSearch = async () => {
  if (!searchInput.value) {
    searchResults.value = [];
    hasSearched.value = false; // Reset if query is empty
    return;
  }

  isSearching.value = true;
  searchErrorMsg.value = null;
  searchResults.value = [];
  hasSearched.value = true; // Set to true right before running search

  try {
    const limit = 50; // Set a reasonable limit for displayed results

    // In stateless mode, always use local search
    if (config.isStateless) {
      const results = localSearch(searchInput.value, limit);
      searchResults.value = results; // Already has { entityId, crateId }
    } else {
      // In stateful mode, try remote search first, fall back to local on error
      try {
        // Construct the URL with query parameters 'q' and 'limit'
        const queryParams = new URLSearchParams({
          q: searchInput.value,
          limit: String(limit),
        }).toString();

        const searchUrl = `${INDEXING_SERVICE_BASE_URL}/search?${queryParams}`;

        const response = await fetch(searchUrl, {
          method: "GET", // Use GET method
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Search failed (${response.status}): ${errText}`);
        }

        const data = await response.json();

        if (!(data && Array.isArray(data.hits))) {
          // If 'data' is null, not an object, or 'hits' isn't an array, throw the error.
          throw new Error(
            "Invalid search response format. Expected an object with a 'hits' array."
          );
        } else {
          // Map the array of hit objects to include both entityId and crateId
          searchResults.value = data.hits.map((hit: any) => ({
            entityId: hit.entity_id,
            crateId: hit.crate_id || currentUrl.value || 'unknown'
          }));
        }
      } catch (remoteError: any) {
        // Fallback to local search if remote search fails
        console.warn('Remote search failed, falling back to local search:', remoteError.message);
        const results = localSearch(searchInput.value, limit);
        searchResults.value = results; // Already has { entityId, crateId }
      }
    }
  } catch (e: any) {
    searchErrorMsg.value = e.message;
    searchResults.value = [];
  } finally {
    isSearching.value = false;
  }
};

const handleSearchSelect = async (result: { entityId: string; crateId: string }) => {
  const { entityId, crateId } = result;

  // Check if the entity is in a different crate than the current one
  const isInCurrentCrate = currentUrl.value === crateId ||
    allEntities.value.some(e => e["@id"] === entityId);

  if (!isInCurrentCrate && crateId && crateCache.has(crateId)) {
    // Navigate to the cached crate first, then select the entity
    const cachedCrate = crateCache.get(crateId);
    if (cachedCrate) {
      // Update baseUrl for the target crate
      try {
        const urlObj = new URL(crateId);
        urlObj.pathname = urlObj.pathname.endsWith("/")
          ? urlObj.pathname
          : urlObj.pathname + "/";
        baseUrl.value = urlObj.href;
      } catch (e) {
        baseUrl.value = crateId.endsWith("/") ? crateId : crateId + "/";
      }

      // Process the cached crate (this updates allEntities)
      await processCrateData(cachedCrate, "Cached Crate", crateId);
    }
  }

  // Now select the entity (should be in the current allEntities)
  selectEntity(entityId);

  // Close the search overlay and clear search state
  isSearchOverlayOpen.value = false;
  searchInput.value = "";
  searchResults.value = [];
  searchErrorMsg.value = null;
  hasSearched.value = false;
};
// ---------------------

// --- Logic: Navigation & Actions ---
const selectEntity = (id: string) => {
  selectedEntityId.value = id;
  updateSelectedEntityView();
};

const handleSelectLink = (entityId: string) => {
  const entity = allEntities.value.find((e) => e["@id"] === entityId);
  if (entity) {
    linkedEntityData.value = extractEntityData(entity);
    isDetailOverlayOpen.value = true;
  }
};

const handleSubcrateOpen = async (subcrateId: string) => {
  if (!baseUrl.value) {
    // Using console.error instead of alert per instructions
    console.error("Cannot determine the base crate identifier for subcrate navigation.");
    return;
  }

  // Push current crate onto history stack BEFORE navigating to subcrate
  // This ensures the breadcrumb hierarchy is maintained
  if (currentUrl.value || baseUrl.value) {
    historyStack.value.push({
      name: currentCrateName.value,
      url: currentUrl.value || baseUrl.value
    });
  }

  // Resolve the subcrate ID to a full URL (handling both absolute and relative paths)
  let resolvedUrl: string;
  try {
    const fullUrl = new URL(subcrateId, baseUrl.value);
    resolvedUrl = fullUrl.href;
  } catch (e) {
    // If URL construction fails, use the subcrateId as-is
    resolvedUrl = subcrateId;
  }

  // Normalize the URL by removing the metadata filename if present
  // This gives us the directory URL which serves as the base for subcrate navigation
  // We also preserve the original metadata filename to use when fetching
  let subcrateBaseUrl: string;
  let metadataFilename: string = "ro-crate-metadata.json"; // Default filename
  try {
    const urlObj = new URL(resolvedUrl);
    // Match any filename ending with ro-crate-metadata.json (e.g., genomics-ro-crate-metadata.json)
    const metadataMatch = urlObj.pathname.match(/([^\/]+ro-crate-metadata\.json)$/i);
    if (metadataMatch && metadataMatch[1]) {
      metadataFilename = metadataMatch[1]; // Preserve the original filename
      const pathParts = urlObj.pathname.split("/");
      pathParts.pop();
      urlObj.pathname = pathParts.join("/");
      if (!urlObj.pathname.endsWith("/")) {
        urlObj.pathname += "/";
      }
      subcrateBaseUrl = urlObj.href;
    } else {
      // If it doesn't end with a metadata filename, ensure trailing slash
      subcrateBaseUrl = resolvedUrl.endsWith("/") ? resolvedUrl : resolvedUrl + "/";
    }
  } catch (e) {
    // Fallback for non-URL strings
    const filenameRegex = /[\/\\]([^\/\\]+ro-crate-metadata\.json)$/i;
    const fallbackMatch = resolvedUrl.match(filenameRegex);
    if (fallbackMatch && fallbackMatch[1]) {
      metadataFilename = fallbackMatch[1];
      subcrateBaseUrl = resolvedUrl.replace(filenameRegex, "/");
    } else {
      subcrateBaseUrl = resolvedUrl.endsWith("/") ? resolvedUrl : resolvedUrl + "/";
    }
  }

  // Special case: empty path becomes "."
  if (subcrateBaseUrl === "") {
    subcrateBaseUrl = ".";
  }

  errorMsg.value = null;

  // Check cache first for faster subcrate navigation (no loading screen needed)
  const cacheKey = subcrateBaseUrl.endsWith("/") ? subcrateBaseUrl : subcrateBaseUrl + "/";
  const cachedCrate = crateCache.get(cacheKey);

  if (cachedCrate && cachedCrate.json && config.isStateless) {
    console.log("Using cached subcrate for:", cacheKey);

    // Update state for cached subcrate
    baseUrl.value = subcrateBaseUrl.endsWith("/") ? subcrateBaseUrl : subcrateBaseUrl + "/";
    inputUrl.value = subcrateBaseUrl;
    currentUrl.value = baseUrl.value;

    await processCrateData(cachedCrate.json, "Subcrate (Cached)", baseUrl.value);
    return;
  }

  // Only show loading for non-cached fetches
  isLoading.value = true;

  try {
    // Stateless mode: fetch directly without indexing service
    if (config.isStateless) {
      // Construct the full URL to the subcrate's metadata file (using preserved filename)
      let fetchUrl: string;
      if (subcrateBaseUrl === ".") {
        fetchUrl = metadataFilename;
      } else if (subcrateBaseUrl.toLowerCase().endsWith("ro-crate-metadata.json")) {
        // Already has the filename (shouldn't happen due to normalization above, but defensive)
        fetchUrl = subcrateBaseUrl;
      } else {
        // Append the preserved metadata filename
        fetchUrl = subcrateBaseUrl.endsWith("/")
          ? subcrateBaseUrl + metadataFilename
          : subcrateBaseUrl + "/" + metadataFilename;
      }

      const json = await fetchCrateFromUrl(fetchUrl);

      // Only update baseUrl after successful fetch to avoid inconsistent state on errors
      baseUrl.value = subcrateBaseUrl.endsWith("/") ? subcrateBaseUrl : subcrateBaseUrl + "/";
      inputUrl.value = subcrateBaseUrl;
      currentUrl.value = baseUrl.value;

      await processCrateData(json, "Subcrate", baseUrl.value);
    } else {
      // Stateful mode: use indexing service
      // The indexing service expects directory URLs without trailing slash
      const apiCrateId = subcrateBaseUrl.endsWith("/")
        ? subcrateBaseUrl.slice(0, -1)
        : subcrateBaseUrl;

      // Update state before fetch for stateful mode (consistent with original behavior)
      baseUrl.value = subcrateBaseUrl.endsWith("/") ? subcrateBaseUrl : subcrateBaseUrl + "/";
      inputUrl.value = subcrateBaseUrl;
      currentUrl.value = baseUrl.value;

      // Fetch metadata (this calls processCrateData internally)
      await fetchMetadata(apiCrateId, "Subcrate", baseUrl.value);
    }
  } catch (e: any) {
    errorMsg.value = `Error loading subcrate: ${e.message}`;
  } finally {
    isLoading.value = false;
  }
};

const goToBreadcrumb = (index: number) => {
  const target = historyStack.value[index];
  if (!target || !target.url) return;

  // Truncate history stack to items before the clicked breadcrumb
  // e.g., clicking on index 1 means we keep items 0 (items before index 1)
  historyStack.value = historyStack.value.slice(0, index);

  inputUrl.value = target.url;
  loadFromUrl();
};

const goBack = () => {
  if (historyStack.value.length === 0) return;
  // Pop the last breadcrumb (parent crate) and navigate to it
  const parent = historyStack.value.pop();
  if (parent && parent.url) {
    inputUrl.value = parent.url;
    loadFromUrl();
  }
};

const resetApp = () => {
  crate.value = undefined;
  allEntities.value = [];
  linkedDataHints.value = {};
  historyStack.value = [];
  currentUrl.value = null;
  errorMsg.value = null;
  shareStatus.value = null;
  shareError.value = null;
  baseUrl.value = "";
  inputUrl.value =
    "https://rocrate.s3.computational.bio.uni-giessen.de/ro-crate-metadata.json";
  contextFilterInput.value = ""; // MODIFIED: Reset filter input on app reset

  // Also reset search state when loading a new crate
  searchInput.value = "";
  searchResults.value = [];
  searchErrorMsg.value = null;
  hasSearched.value = false;

  // Clear the crate cache and root URL
  crateCache.clear();
  rootCrateUrl.value = null;

  // Clear the search index
  clearSearchIndex();
};

onMounted(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const crateUrlParam = urlParams.get("crateUrl");
  const crateParam = urlParams.get("crate");

  if (crateParam) {
    try {
      const parsed = JSON.parse(crateParam);
      // Shared crate is always a fresh start
      processCrateData(parsed, "Shared Crate", null, true);

      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("crate");
      window.history.replaceState({}, "", cleanUrl.toString());
    } catch (e: any) {
      errorMsg.value = `Failed to load shared crate: ${e.message || e}`;
    }
  } else if (crateUrlParam) {
    inputUrl.value = decodeURIComponent(crateUrlParam);
    loadFromUrl();
  }

  // Theme Init
  const storedTheme = localStorage.getItem("theme");
  if (storedTheme === "light") {
    isDark.value = false;
    document.documentElement.classList.remove("dark");
  } else {
    isDark.value = true;
    document.documentElement.classList.add("dark");
  }
});

onUnmounted(() => {
  if (shareToastTimeout) {
    clearTimeout(shareToastTimeout);
  }
});

// Debounced search for stateless mode - search as user types
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchInput, (newValue) => {
  if (!config.isStateless) return;

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  if (!newValue) {
    searchResults.value = [];
    hasSearched.value = false;
    return;
  }

  searchDebounceTimer = setTimeout(() => {
    runSearch();
  }, 150); // Short debounce for responsive feel
});

const showShareToast = (message: string, isError = false) => {
  shareToastMessage.value = message;
  shareToastIsError.value = isError;
  shareToastVisible.value = true;

  if (shareToastTimeout) {
    clearTimeout(shareToastTimeout);
  }

  shareToastTimeout = setTimeout(() => {
    shareToastVisible.value = false;
  }, 3500);
};

const copyShareLink = async () => {
  shareStatus.value = null;
  shareError.value = null;

  if (!fullCrateJson.value) {
    shareError.value = "Load a crate first to share.";
    showShareToast(shareError.value, true);
    return;
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("crateUrl");
    url.searchParams.set("crate", fullCrateJson.value);

    const shareLink = url.toString();

    if (shareLink.length > SHARE_URL_LIMIT) {
      shareError.value = `Crate is too large to share via URL (length ${shareLink.length} > limit ${SHARE_URL_LIMIT}).`;
      showShareToast(shareError.value, true);
      return;
    }

    await navigator.clipboard.writeText(shareLink);
    shareStatus.value = "Share link copied to clipboard.";
    showShareToast(shareStatus.value);
  } catch (e: any) {
    shareError.value = `Failed to copy share link: ${e.message || e}`;
    showShareToast(shareError.value, true);
  }
};
</script>

<template>
  <div
    class="flex flex-col min-h-screen pb-10 relative isolate bg-(--c-bg-app) text-(--c-text-muted) transition-colors duration-300"
  >
    <img
      :src="arunaBg"
      alt=""
      class="fixed inset-0 w-full h-full object-cover -z-10 opacity-10 pointer-events-none"
    />

    <div
      class="w-full border-b border-(--c-border) bg-(--c-bg-card)/90 backdrop-blur-sm shadow-sm flex justify-center px-4 md:px-6 transition-colors duration-300"
    >
      <div class="w-full max-w-[1600px] py-4 flex justify-between items-center">
        <h1
          class="text-3xl font-light text-(--c-text-main) cursor-pointer select-none hover:text-[#00A0CC] transition-colors"
          @click="resetApp"
        >
          RO-Crate Explorer
        </h1>
        <div class="flex items-center gap-3">
          <Button
            v-if="allEntities.length > 0"
            variant="ghost"
            size="sm"
            class="h-9 px-3 rounded-full border border-(--c-border) hover:bg-(--c-hover) text-(--c-text-muted) hover:text-(--c-text-main)"
            @click="copyShareLink"
            :disabled="!fullCrateJson || isCrateTooLargeToShare"
            :title="isCrateTooLargeToShare ? 'Crate is too large to share via URL' : 'Copy a shareable URL with the current crate embedded'"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="mr-2"
            >
              <path d="M15 7h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-3" />
              <path d="M10 14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" />
              <path d="M10 10 14 6" />
              <path d="M10 6h4v4" />
            </svg>
            Share
          </Button>
          <Button
            v-if="allEntities.length > 0"
            variant="ghost"
            size="sm"
            class="h-9 w-9 p-0 rounded-full border border-(--c-border) hover:bg-(--c-hover) text-(--c-text-muted) hover:text-(--c-text-main)"
            @click="isSearchOverlayOpen = true"
            title="Search Crate"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            class="h-9 w-9 p-0 rounded-full border border-(--c-border) hover:bg-(--c-hover) text-(--c-text-muted) hover:text-(--c-text-main)"
            @click="toggleTheme"
          >
            <svg
              v-if="isDark"
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2" />
              <path d="M12 20v2" />
              <path d="m4.93 4.93 1.41 1.41" />
              <path d="m17.66 17.66 1.41 1.41" />
              <path d="M2 12h2" />
              <path d="M20 12h2" />
              <path d="m6.34 17.66-1.41 1.41" />
              <path d="m19.07 4.93-1.41 1.41" />
            </svg>
            <svg
              v-else
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
            </svg>
          </Button>
          <Button
            v-if="allEntities.length > 0"
            variant="secondary"
            size="sm"
            class="bg-(--c-hover) text-(--c-text-main) hover:bg-[#00A0CC] hover:text-white border border-(--c-border)"
            @click="resetApp"
          >
            Load New Crate
          </Button>
        </div>
      </div>
    </div>

    <div class="grow w-full px-4 md:px-6 pt-6 flex flex-col items-center">
      <div
        v-if="errorMsg"
        class="w-full max-w-4xl bg-red-900/20 border border-red-800 text-red-400 px-4 py-3 rounded mb-6"
        role="alert"
      >
        <span class="block sm:inline">{{ errorMsg }}</span>
      </div>

      <div
        v-if="allEntities.length === 0 && !isLoading"
        class="grow flex flex-col items-center justify-center w-full max-w-5xl"
      >
        <Card
          class="w-full max-w-xl shadow-xl bg-(--c-bg-card) border-(--c-border)"
        >
          <CardHeader>
            <CardTitle class="text-2xl text-center text-(--c-text-main)"
              >Load RO-Crate</CardTitle
            >
            <CardDescription class="text-center text-(--c-text-muted)"
              >Paste JSON, provide a URL, or upload a ZIP/JSON file.</CardDescription
            >
          </CardHeader>
          <CardContent class="flex flex-col gap-8 p-8">
            <div class="space-y-2">
              <label
                class="text-sm font-semibold text-(--c-text-muted) block text-center"
                >Paste the contents of <code>ro-crate-metadata.json</code></label
              >
              <textarea
                v-model="pastedCrateText"
                class="w-full min-h-[180px] rounded-md border border-(--c-border) bg-(--c-bg-app) text-(--c-text-main) px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
                placeholder='{\n  "@context": "https://w3id.org/ro/crate/1.1/context",\n  "@graph": [ ... ]\n}'
              ></textarea>
              <Button
                class="w-full h-11 bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white"
                @click="loadFromPastedJson"
                >Load Pasted Crate</Button
              >
            </div>
            <div class="relative">
              <div class="absolute inset-0 flex items-center">
                <span class="w-full border-t border-(--c-border)" />
              </div>
              <div class="relative flex justify-center text-xs uppercase tracking-wider">
                <span class="bg-(--c-bg-card) px-2 text-(--c-text-muted)/60"
                  >Or load from URL</span
                >
              </div>
            </div>
            <div class="flex w-full items-center space-x-2 gap-2">
              <input
                v-model="inputUrl"
                type="text"
                class="flex h-11 w-full rounded-md border border-(--c-border) bg-(--c-bg-app) text-(--c-text-main) px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
                placeholder="https://..."
              />
              <Button
                class="h-11 px-6 bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white"
                @click="loadFromUrl"
                >Load</Button
              >
            </div>
            <div class="relative">
              <div class="absolute inset-0 flex items-center">
                <span class="w-full border-t border-(--c-border)" />
              </div>
              <div class="relative flex justify-center text-xs uppercase tracking-wider">
                <span class="bg-(--c-bg-card) px-2 text-(--c-text-muted)/60"
                  >Or upload a file</span
                >
              </div>
            </div>
            <div class="space-y-3">
              <label
                class="text-sm font-semibold text-(--c-text-muted) block text-center"
                >Upload File</label
              >
              <div class="flex items-center justify-center w-full">
                <label
                  for="dropzone-file"
                  class="flex flex-col items-center justify-center w-full h-32 border-2 border-(--c-border) border-dashed rounded-lg cursor-pointer bg-(--c-bg-app) hover:bg-(--c-hover) transition-colors group"
                >
                  <div
                    class="flex flex-col items-center justify-center pt-5 pb-6 text-center"
                  >
                    <p
                      class="text-sm text-(--c-text-muted) group-hover:text-(--c-text-main) transition-colors"
                    >
                      <span class="font-semibold text-[#00A0CC]">Click to upload</span> or
                      drag and drop
                    </p>
                    <p class="text-xs text-(--c-text-muted)/60 mt-1">
                      .zip archive or .json metadata
                    </p>
                  </div>
                  <input
                    id="dropzone-file"
                    type="file"
                    class="hidden"
                    accept=".json,.zip"
                    @change="handleFileUpload"
                  />
                </label>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div
        v-if="isLoading"
        class="grow flex flex-col items-center justify-center w-full"
      >
        <div
          class="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-[#00A0CC] mb-6"
        ></div>
        <p class="text-xl text-(--c-text-muted) font-light">Processing Crate...</p>
      </div>

      <div
        v-if="allEntities.length > 0 && !isLoading"
        class="w-full max-w-[1600px] flex flex-col gap-4 h-[80vh]"
      >
        <div
          class="w-full bg-(--c-bg-card) border border-(--c-border) text-(--c-text-muted) rounded-md p-3 flex items-center gap-4 shadow-sm"
        >
          <Button
            variant="outline"
            size="sm"
            @click="goBack"
            :disabled="historyStack.length === 0"
            class="flex items-center gap-1 border-(--c-border) bg-(--c-bg-app) hover:bg-(--c-hover) text-(--c-text-muted) hover:text-(--c-text-main)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </Button>
          <nav class="flex items-center flex-wrap text-sm text-(--c-text-muted)">
            <template v-for="(item, index) in historyStack" :key="index">
              <button
                @click="goToBreadcrumb(index)"
                class="hover:text-[#00A0CC] font-medium px-1 cursor-pointer"
              >
                {{ item.name }}
              </button>
              <span class="text-(--c-text-muted)/40 mx-1">/</span>
            </template>
            <span class="font-bold text-[#00A0CC] px-1">{{ currentCrateName }}</span>
          </nav>
        </div>

        <div
          class="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6 h-full overflow-hidden pb-2 w-full"
        >
          <aside
            class="col-span-1 bg-(--c-bg-card) border border-(--c-border) rounded-lg shadow-sm flex flex-col h-full overflow-hidden transition-colors duration-300"
          >
            <div
              class="p-3 bg-(--c-bg-app) border-b border-(--c-border) shrink-0"
            >
              <h2
                class="text-xs font-bold text-(--c-text-muted)/80 uppercase tracking-wider"
              >
                Files
              </h2>
            </div>
            <div class="flex-1 overflow-y-auto p-2">
              <FileTreeItem
                :node="fileTree"
                :selectedId="selectedEntityId"
                @select="selectEntity"
              />
            </div>
            <div
              class="h-1 bg-(--c-bg-app) border-t border-b border-(--c-border)"
            ></div>

            <div
              class="p-3 bg-(--c-bg-app) border-b border-(--c-border) shrink-0 flex flex-col gap-2"
            >
              <h2
                class="text-xs font-bold text-(--c-text-muted)/80 uppercase tracking-wider"
              >
                Context Entities
              </h2>
              <input
                v-model="contextFilterInput"
                type="text"
                class="flex h-7 w-full rounded-md border border-(--c-border) bg-(--c-bg-card) text-(--c-text-main) px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00A0CC] placeholder:text-gray-500/80"
                placeholder="Filter by Type (e.g., Person, Organization)"
              />
            </div>
            <div class="flex-1 overflow-y-auto p-2">
              <div
                v-for="(entities, groupName) in otherEntitiesGroups"
                :key="groupName"
                class="mb-4"
              >
                <h3
                  class="text-[10px] font-bold text-[#00A0CC] uppercase mb-1 px-2 tracking-widest"
                >
                  {{ groupName }}
                </h3>
                <div class="flex flex-col gap-px">
                  <button
                    v-for="entity in entities"
                    :key="entity['@id']"
                    @click="selectEntity(entity['@id'])"
                    :class="[
                      'text-left px-2 py-1 text-sm rounded-sm hover:bg-(--c-hover) transition-all truncate border-l-2 w-full',
                      selectedEntityId === entity['@id']
                        ? 'bg-(--c-hover) text-[#00A0CC] border-[#00A0CC] font-medium shadow-sm'
                        : 'text-(--c-text-muted) border-transparent',
                    ]"
                    :title="entity['@id']"
                  >
                    {{ entity["name"] || entity["@id"] }}
                  </button>
                </div>
              </div>
            </div>
          </aside>

          <main class="col-span-1 flex flex-col h-full overflow-hidden min-w-0">
            <div class="flex-1 h-full min-h-0 pr-1">
              <RoCrateEntity
                v-if="selectedEntityData"
                :id="selectedEntityData.id"
                :type="selectedEntityData.type"
                :otherProps="selectedEntityData.otherProps"
                :fullCrateJson="fullCrateJson"
                :linkedData="linkedDataHints[selectedEntityId] || {}"
                @select-link="handleSelectLink"
                @open-subcrate="handleSubcrateOpen"
                class="w-full"
              />
              <div
                v-else
                class="h-full flex flex-col items-center justify-center bg-(--c-bg-card) border border-dashed border-(--c-border) rounded-lg text-(--c-text-muted)/50 transition-colors duration-300"
              >
                <p>Select an entity to view details.</p>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>

    <AlertDialog :open="isDetailOverlayOpen" @update:open="isDetailOverlayOpen = $event">
      <AlertDialogContent
        class="text-(--c-text-muted) bg-(--c-bg-card) border-(--c-border) max-w-4xl max-h-[80vh] overflow-y-auto"
      >
        <button
          class="absolute right-4 top-4 p-1 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none hover:bg-(--c-hover) text-(--c-text-muted)"
          @click="isDetailOverlayOpen = false"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
          <span class="sr-only">Close</span>
        </button>
        <AlertDialogHeader>
          <AlertDialogTitle class="flex items-center gap-2 text-(--c-text-main)"
            ><span
              class="bg-(--c-hover) text-[#00A0CC] text-xs px-2 py-0.5 rounded uppercase"
              >Linked Entity</span
            >
            {{ linkedEntityData?.id }}</AlertDialogTitle
          >
          <AlertDialogDescription class="text-(--c-text-muted)/80"
            >Type: {{ linkedEntityData?.type }}</AlertDialogDescription
          >
        </AlertDialogHeader>
        <div v-if="linkedEntityData" class="p-1 flex flex-col gap-1.5">
          <div
            v-for="(propString, index) in linkedEntityData.otherProps"
            :key="index"
            class="p-3 bg-(--c-bg-app) rounded border border-(--c-border) text-sm"
          >
            <div class="font-bold text-(--c-text-muted) text-xs uppercase mb-1">
              {{ propString.split(":\n")[0] }}
            </div>
            <div
              class="whitespace-pre-wrap font-mono text-xs text-(--c-text-muted)/80"
            >
              {{ propString.split(":\n")[1] }}
            </div>
          </div>
        </div>
        <AlertDialogFooter
          ><AlertDialogAction
            class="bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white"
            @click="isDetailOverlayOpen = false"
            >Close</AlertDialogAction
          ></AlertDialogFooter
        >
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog :open="isSearchOverlayOpen" @update:open="isSearchOverlayOpen = $event">
      <AlertDialogContent
        class="text-(--c-text-muted) bg-(--c-bg-card) border-(--c-border) max-w-xl! max-h-[80vh] overflow-y-auto"
      >
        <button
          class="absolute right-4 top-4 p-1 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none hover:bg-(--c-hover) text-(--c-text-muted)"
          @click="isSearchOverlayOpen = false"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
          <span class="sr-only">Close</span>
        </button>
        <AlertDialogHeader>
          <AlertDialogTitle class="text-(--c-text-main)"
            >Search RO-Crate Entities</AlertDialogTitle
          >
          <AlertDialogDescription v-if="!config.isStateless" class="text-(--c-text-muted)/80"
            >Use the Tantivy query format, e.g.,
            <code class="bg-(--c-bg-app) px-1 rounded font-mono"
              >author.name:Smith AND entity_type:Dataset</code
            >.</AlertDialogDescription
          >
          <AlertDialogDescription v-else class="text-(--c-text-muted)/80"
            >Search by entity ID, name, or type.</AlertDialogDescription
          >
        </AlertDialogHeader>

        <div class="flex w-full items-center space-x-2 gap-2">
          <input
            v-model="searchInput"
            @keyup.enter="runSearch"
            type="text"
            class="flex h-10 w-full rounded-md border border-(--c-border) bg-(--c-bg-app) text-(--c-text-main) px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
            placeholder="Search query..."
          />
          <Button
            v-if="!config.isStateless"
            class="h-10 px-4 bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white shrink-0"
            @click="runSearch"
            :disabled="isSearching || !searchInput"
          >
            <svg
              v-if="isSearching"
              class="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            Search
          </Button>
        </div>

        <div
          v-if="searchErrorMsg"
          class="w-full bg-red-900/20 border border-red-800 text-red-400 px-3 py-2 text-sm rounded mt-2"
          role="alert"
        >
          {{ searchErrorMsg }}
        </div>

        <div
          v-if="searchResults.length > 0"
          class="mt-4 p-2 bg-(--c-bg-app) rounded border border-(--c-border) max-h-[30vh] overflow-y-auto"
        >
          <p
            class="text-xs font-bold text-(--c-text-muted)/80 uppercase tracking-wider mb-1 px-1"
          >
            {{ searchResults.length }} result(s) found
          </p>
          <div class="flex flex-col gap-1">
            <button
              v-for="result in searchResults"
              :key="result.entityId + result.crateId"
              @click="handleSearchSelect(result)"
              class="w-full text-left p-2 text-sm rounded-md hover:bg-(--c-hover) transition-colors text-(--c-text-main) truncate font-mono"
              :class="{
                'bg-(--c-hover) text-[#00A0CC] font-semibold':
                  selectedEntityId === result.entityId,
              }"
              :title="result.entityId"
            >
              <span>{{ result.entityId }}</span>
              <span
                v-if="result.crateId !== currentUrl"
                class="ml-2 text-xs text-(--c-text-muted)/60"
              >({{ result.crateId.split('/').slice(-2, -1)[0] || 'other crate' }})</span>
            </button>
          </div>
        </div>
        <div
          v-else-if="hasSearched && !isSearching"
          class="mt-4 p-2 text-center text-sm text-(--c-text-muted)/60"
        >
          No results found for the last query.
        </div>

        <AlertDialogFooter>
          <AlertDialogAction
            class="bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white"
            @click="isSearchOverlayOpen = false"
            >Close</AlertDialogAction
          >
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <div
      v-if="shareToastVisible && shareToastMessage"
      class="fixed bottom-4 right-4 z-50"
    >
      <div
        class="rounded-md px-4 py-3 shadow-lg text-sm border"
        :class="
          shareToastIsError
            ? 'bg-red-100 text-red-800 border-red-200'
            : 'bg-emerald-100 text-emerald-800 border-emerald-200'
        "
        role="status"
        aria-live="polite"
      >
        {{ shareToastMessage }}
      </div>
    </div>
  </div>
</template>

<style>
body {
  margin: 0 !important;
  padding: 0 !important;
  width: 100% !important;
  min-height: 100vh !important;
  display: block !important;
  background-color: var(--c-bg-app) !important;
}

#app {
  display: block !important;
  width: 100% !important;
  max-width: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  text-align: left !important;
  grid-template-columns: none !important;
}
</style>
