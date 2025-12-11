<script setup lang="ts">
import RoCrateEntity from "@/components/custom-ui/RoCrateEntity.vue";
import FileTreeItem from "@/components/custom-ui/FileTreeItem.vue";
import { ROCrate } from "ro-crate";
import { onMounted, ref, computed } from "vue";
import { Button } from "@/components/ui/button";

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

const INDEXING_SERVICE_BASE_URL = "http://localhost:3000";

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

// --- Search State ---
const isSearchOverlayOpen = ref(false);
const searchInput = ref<string>("");
const searchResults = ref<string[]>([]);
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

const processCrateData = async (
  json: any,
  sourceName: string,
  sourceUrl: string | null = null
) => {
  try {
    allEntities.value = [];
    selectedEntityId.value = "./";
    selectedEntityData.value = null;

    crate.value = new ROCrate(json, { array: true, link: true });

    allEntities.value = json["@graph"] || [];
    fullCrateJson.value = JSON.stringify(json, null, 2);
    currentUrl.value = sourceUrl;

    try {
      const expanded = await jsonld.expand(json);
      expandedCrate.value = expanded;
      console.log("Expanded crate:");
      console.log({ expandedCrate });
      console.log(expandedCrate);

      // Precompute linked-data hints (property/value IRIs) once per crate
      linkedDataHints.value = await buildLinkedDataHints(json, expanded);
    } catch (e) {
      console.error("Expansion failed:", e);
      expandedCrate.value = [];
      linkedDataHints.value = {};
    }

    const rootEntity =
      allEntities.value.find((e) => e["@id"] === "./" || e["@id"] === ".") ||
      crate.value?.rootDataset;
    currentCrateName.value = getSafeName(rootEntity, sourceName);

    updateSelectedEntityView();
  } catch (e: any) {
    errorMsg.value = "Failed to process RO-Crate JSON: " + e.message;
  }
};

const fetchMetadata = async (
  crateId: string,
  sourceName: string,
  sourceUrl: string | null = null
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
    processCrateData(metadataJson, sourceName, sourceUrl);
  } catch (e: any) {
    throw new Error(`Metadata fetch failed: ${e.message}`);
  }
};

const loadFromUrl = async () => {
  if (!inputUrl.value) return;
  isLoading.value = true;
  errorMsg.value = null;

  try {
    const fetchUrl = inputUrl.value;

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

          await fetchMetadata(crateId, "Remote Crate (Indexed)", fetchUrl);
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
    await fetchMetadata(crateId, "Remote Crate", fetchUrl);
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
    processCrateData(parsed, "Pasted Crate", null);
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

    await fetchMetadata(crateId, file.name, null);
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
    // Construct the URL with query parameters 'q' and 'limit'
    const limit = 50; // Set a reasonable limit for displayed results
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
      // Map the array of hit objects to an array of entity_id strings
      searchResults.value = data.hits.map((hit: any) => hit.entity_id);
    }
  } catch (e: any) {
    searchErrorMsg.value = e.message;
    searchResults.value = [];
  } finally {
    isSearching.value = false;
  }
};

const handleSearchSelect = (entityId: string) => {
  // 1. Select the entity in the main view
  selectEntity(entityId);
  // 2. Close the search overlay
  isSearchOverlayOpen.value = false;
  // 3. Clear search state and reset hasSearched
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

const handleSubcrateOpen = (subcrateId: string) => {
  if (!baseUrl.value) {
    // Using console.error instead of alert per instructions
    console.error("Cannot determine the base crate identifier for subcrate navigation.");
    return;
  }

  // Preserve the current state for history navigation
  const currentHistoryUrl = currentUrl.value || baseUrl.value;
  historyStack.value.push({ name: currentCrateName.value, url: currentHistoryUrl });

  let apiCrateId = subcrateId;

  try {
    const fullUrl = new URL(subcrateId, baseUrl.value);

    if (fullUrl.pathname.toLowerCase().endsWith("ro-crate-metadata.json")) {
      const pathParts = fullUrl.pathname.split("/");
      pathParts.pop();

      fullUrl.pathname = pathParts.join("/");

      if (!fullUrl.pathname.endsWith("/")) {
        fullUrl.pathname += "/";
      }

      apiCrateId = fullUrl.href;
    }
  } catch (e) {
    const filenameRegex = /[\/\\]ro-crate-metadata\.json$/i;
    if (filenameRegex.test(apiCrateId)) {
      apiCrateId = apiCrateId.replace(filenameRegex, "");
    }
  }

  if (apiCrateId === "") apiCrateId = ".";

  // FIX: Redefine baseUrl to the ID of the subcrate we just navigated to.
  // This is crucial for resolving subsequent relative paths correctly.
  baseUrl.value = apiCrateId.endsWith("/") ? apiCrateId : apiCrateId + "/";

  // Update inputUrl (for future loadFromUrl calls) and currentUrl (for display)
  inputUrl.value = apiCrateId;
  currentUrl.value = baseUrl.value; // Use the new base URL for history tracking

  isLoading.value = true;
  errorMsg.value = null;

  fetchMetadata(apiCrateId, "Subcrate", baseUrl.value).finally(() => {
    isLoading.value = false;
  });
};

const goToBreadcrumb = (index: number) => {
  const target = historyStack.value[index];
  if (!target || !target.url) return;

  historyStack.value = historyStack.value.slice(0, index);
  inputUrl.value = target.url;
  loadFromUrl();
};

const goBack = () => {
  if (historyStack.value.length === 0) return;
  const previous = historyStack.value.pop();
  if (previous && previous.url) {
    inputUrl.value = previous.url;
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
};

onMounted(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const crateUrlParam = urlParams.get("crateUrl");
  const crateParam = urlParams.get("crate");

  if (crateParam) {
    try {
      const parsed = JSON.parse(crateParam);
      processCrateData(parsed, "Shared Crate", null);

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
    class="flex flex-col min-h-screen pb-10 relative isolate bg-[var(--c-bg-app)] text-[var(--c-text-muted)] transition-colors duration-300"
  >
    <img
      :src="arunaBg"
      alt=""
      class="fixed inset-0 w-full h-full object-cover -z-10 opacity-10 pointer-events-none"
    />

    <div
      class="w-full border-b border-[var(--c-border)] bg-[var(--c-bg-card)]/90 backdrop-blur-sm shadow-sm flex justify-center px-4 md:px-6 transition-colors duration-300"
    >
      <div class="w-full max-w-[1600px] py-4 flex justify-between items-center">
        <h1
          class="text-3xl font-light text-[var(--c-text-main)] cursor-pointer select-none hover:text-[#00A0CC] transition-colors"
          @click="resetApp"
        >
          RO-Crate Explorer
        </h1>
        <div class="flex items-center gap-3">
          <Button
            v-if="allEntities.length > 0"
            variant="ghost"
            size="sm"
            class="h-9 px-3 rounded-full border border-[var(--c-border)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]"
            @click="copyShareLink"
            :disabled="!fullCrateJson"
            title="Copy a shareable URL with the current crate embedded"
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
            class="h-9 w-9 p-0 rounded-full border border-[var(--c-border)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]"
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
            class="h-9 w-9 p-0 rounded-full border border-[var(--c-border)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]"
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
            class="bg-[var(--c-hover)] text-[var(--c-text-main)] hover:bg-[#00A0CC] hover:text-white border border-[var(--c-border)]"
            @click="resetApp"
          >
            Load New Crate
          </Button>
        </div>
      </div>
    </div>

    <div class="flex-grow w-full px-4 md:px-6 pt-6 flex flex-col items-center">
      <div
        v-if="errorMsg"
        class="w-full max-w-4xl bg-red-900/20 border border-red-800 text-red-400 px-4 py-3 rounded mb-6"
        role="alert"
      >
        <span class="block sm:inline">{{ errorMsg }}</span>
      </div>

      <div
        v-if="allEntities.length === 0 && !isLoading"
        class="flex-grow flex flex-col items-center justify-center w-full max-w-5xl"
      >
        <Card
          class="w-full max-w-xl shadow-xl bg-[var(--c-bg-card)] border-[var(--c-border)]"
        >
          <CardHeader>
            <CardTitle class="text-2xl text-center text-[var(--c-text-main)]"
              >Load RO-Crate</CardTitle
            >
            <CardDescription class="text-center text-[var(--c-text-muted)]"
              >Paste JSON, provide a URL, or upload a ZIP/JSON file.</CardDescription
            >
          </CardHeader>
          <CardContent class="flex flex-col gap-8 p-8">
            <div class="space-y-2">
              <label
                class="text-sm font-semibold text-[var(--c-text-muted)] block text-center"
                >Paste the contents of <code>ro-crate-metadata.json</code></label
              >
              <textarea
                v-model="pastedCrateText"
                class="w-full min-h-[180px] rounded-md border border-[var(--c-border)] bg-[var(--c-bg-app)] text-[var(--c-text-main)] px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
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
                <span class="w-full border-t border-[var(--c-border)]" />
              </div>
              <div class="relative flex justify-center text-xs uppercase tracking-wider">
                <span class="bg-[var(--c-bg-card)] px-2 text-[var(--c-text-muted)]/60"
                  >Or load from URL</span
                >
              </div>
            </div>
            <div class="flex w-full items-center space-x-2 gap-2">
              <input
                v-model="inputUrl"
                type="text"
                class="flex h-11 w-full rounded-md border border-[var(--c-border)] bg-[var(--c-bg-app)] text-[var(--c-text-main)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
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
                <span class="w-full border-t border-[var(--c-border)]" />
              </div>
              <div class="relative flex justify-center text-xs uppercase tracking-wider">
                <span class="bg-[var(--c-bg-card)] px-2 text-[var(--c-text-muted)]/60"
                  >Or upload a file</span
                >
              </div>
            </div>
            <div class="space-y-3">
              <label
                class="text-sm font-semibold text-[var(--c-text-muted)] block text-center"
                >Upload File</label
              >
              <div class="flex items-center justify-center w-full">
                <label
                  for="dropzone-file"
                  class="flex flex-col items-center justify-center w-full h-32 border-2 border-[var(--c-border)] border-dashed rounded-lg cursor-pointer bg-[var(--c-bg-app)] hover:bg-[var(--c-hover)] transition-colors group"
                >
                  <div
                    class="flex flex-col items-center justify-center pt-5 pb-6 text-center"
                  >
                    <p
                      class="text-sm text-[var(--c-text-muted)] group-hover:text-[var(--c-text-main)] transition-colors"
                    >
                      <span class="font-semibold text-[#00A0CC]">Click to upload</span> or
                      drag and drop
                    </p>
                    <p class="text-xs text-[var(--c-text-muted)]/60 mt-1">
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
        class="flex-grow flex flex-col items-center justify-center w-full"
      >
        <div
          class="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-[#00A0CC] mb-6"
        ></div>
        <p class="text-xl text-[var(--c-text-muted)] font-light">Processing Crate...</p>
      </div>

      <div
        v-if="allEntities.length > 0 && !isLoading"
        class="w-full max-w-[1600px] flex flex-col gap-4 h-[80vh]"
      >
        <div
          class="w-full bg-[var(--c-bg-card)] border border-[var(--c-border)] text-[var(--c-text-muted)] rounded-md p-3 flex items-center gap-4 shadow-sm"
        >
          <Button
            variant="outline"
            size="sm"
            @click="goBack"
            :disabled="historyStack.length === 0"
            class="flex items-center gap-1 border-[var(--c-border)] bg-[var(--c-bg-app)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]"
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
          <nav class="flex items-center flex-wrap text-sm text-[var(--c-text-muted)]">
            <template v-for="(item, index) in historyStack" :key="index">
              <button
                @click="goToBreadcrumb(index)"
                class="hover:text-[#00A0CC] font-medium px-1 cursor-pointer"
              >
                {{ item.name }}
              </button>
              <span class="text-[var(--c-text-muted)]/40 mx-1">/</span>
            </template>
            <span class="font-bold text-[#00A0CC] px-1">{{ currentCrateName }}</span>
          </nav>
        </div>

        <div
          class="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6 h-full overflow-hidden pb-2 w-full"
        >
          <aside
            class="col-span-1 bg-[var(--c-bg-card)] border border-[var(--c-border)] rounded-lg shadow-sm flex flex-col h-full overflow-hidden transition-colors duration-300"
          >
            <div
              class="p-3 bg-[var(--c-bg-app)] border-b border-[var(--c-border)] flex-shrink-0"
            >
              <h2
                class="text-xs font-bold text-[var(--c-text-muted)]/80 uppercase tracking-wider"
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
              class="h-1 bg-[var(--c-bg-app)] border-t border-b border-[var(--c-border)]"
            ></div>

            <div
              class="p-3 bg-[var(--c-bg-app)] border-b border-[var(--c-border)] flex-shrink-0 flex flex-col gap-2"
            >
              <h2
                class="text-xs font-bold text-[var(--c-text-muted)]/80 uppercase tracking-wider"
              >
                Context Entities
              </h2>
              <input
                v-model="contextFilterInput"
                type="text"
                class="flex h-7 w-full rounded-md border border-[var(--c-border)] bg-[var(--c-bg-card)] text-[var(--c-text-main)] px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#00A0CC] placeholder:text-gray-500/80"
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
                <div class="flex flex-col gap-[1px]">
                  <button
                    v-for="entity in entities"
                    :key="entity['@id']"
                    @click="selectEntity(entity['@id'])"
                    :class="[
                      'text-left px-2 py-1 text-sm rounded-sm hover:bg-[var(--c-hover)] transition-all truncate border-l-2 w-full',
                      selectedEntityId === entity['@id']
                        ? 'bg-[var(--c-hover)] text-[#00A0CC] border-[#00A0CC] font-medium shadow-sm'
                        : 'text-[var(--c-text-muted)] border-transparent',
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
                class="h-full flex flex-col items-center justify-center bg-[var(--c-bg-card)] border border-dashed border-[var(--c-border)] rounded-lg text-[var(--c-text-muted)]/50 transition-colors duration-300"
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
        class="text-[var(--c-text-muted)] bg-[var(--c-bg-card)] border-[var(--c-border)] max-w-4xl max-h-[80vh] overflow-y-auto"
      >
        <button
          class="absolute right-4 top-4 p-1 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none hover:bg-[var(--c-hover)] text-[var(--c-text-muted)]"
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
          <AlertDialogTitle class="flex items-center gap-2 text-[var(--c-text-main)]"
            ><span
              class="bg-[var(--c-hover)] text-[#00A0CC] text-xs px-2 py-0.5 rounded uppercase"
              >Linked Entity</span
            >
            {{ linkedEntityData?.id }}</AlertDialogTitle
          >
          <AlertDialogDescription class="text-[var(--c-text-muted)]/80"
            >Type: {{ linkedEntityData?.type }}</AlertDialogDescription
          >
        </AlertDialogHeader>
        <div v-if="linkedEntityData" class="p-1 flex flex-col gap-1.5">
          <div
            v-for="(propString, index) in linkedEntityData.otherProps"
            :key="index"
            class="p-3 bg-[var(--c-bg-app)] rounded border border-[var(--c-border)] text-sm"
          >
            <div class="font-bold text-[var(--c-text-muted)] text-xs uppercase mb-1">
              {{ propString.split(":\n")[0] }}
            </div>
            <div
              class="whitespace-pre-wrap font-mono text-xs text-[var(--c-text-muted)]/80"
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
        class="text-[var(--c-text-muted)] bg-[var(--c-bg-card)] border-[var(--c-border)] !max-w-xl max-h-[80vh] overflow-y-auto"
      >
        <button
          class="absolute right-4 top-4 p-1 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none hover:bg-[var(--c-hover)] text-[var(--c-text-muted)]"
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
          <AlertDialogTitle class="text-[var(--c-text-main)]"
            >Search RO-Crate Entities</AlertDialogTitle
          >
          <AlertDialogDescription class="text-[var(--c-text-muted)]/80"
            >Use the Tantivy query format, e.g.,
            <code class="bg-[var(--c-bg-app)] px-1 rounded font-mono"
              >author.name:Smith AND entity_type:Dataset</code
            >.</AlertDialogDescription
          >
        </AlertDialogHeader>

        <div class="flex w-full items-center space-x-2 gap-2">
          <input
            v-model="searchInput"
            @keyup.enter="runSearch"
            type="text"
            class="flex h-10 w-full rounded-md border border-[var(--c-border)] bg-[var(--c-bg-app)] text-[var(--c-text-main)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500"
            placeholder="Search query..."
          />
          <Button
            class="h-10 px-4 bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white flex-shrink-0"
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
          class="mt-4 p-2 bg-[var(--c-bg-app)] rounded border border-[var(--c-border)] max-h-[30vh] overflow-y-auto"
        >
          <p
            class="text-xs font-bold text-[var(--c-text-muted)]/80 uppercase tracking-wider mb-1 px-1"
          >
            {{ searchResults.length }} result(s) found
          </p>
          <div class="flex flex-col gap-1">
            <button
              v-for="id in searchResults"
              :key="id"
              @click="handleSearchSelect(id)"
              class="w-full text-left p-2 text-sm rounded-md hover:bg-[var(--c-hover)] transition-colors text-[var(--c-text-main)] truncate font-mono"
              :class="{
                'bg-[var(--c-hover)] text-[#00A0CC] font-semibold':
                  selectedEntityId === id,
              }"
              :title="id"
            >
              {{ id }}
            </button>
          </div>
        </div>
        <div
          v-else-if="hasSearched && !isSearching"
          class="mt-4 p-2 text-center text-sm text-[var(--c-text-muted)]/60"
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
