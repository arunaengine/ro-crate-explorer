<script setup lang="ts">
import RoCrateEntity from '@/components/custom-ui/RoCrateEntity.vue'
import FileTreeItem from '@/components/custom-ui/FileTreeItem.vue'
import { ROCrate } from 'ro-crate'
import { onMounted, ref, computed, watch } from 'vue'
import { Button } from '@/components/ui/button'
import JSZip from 'jszip'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@/components/ui/card";

import arunaBg from '@/assets/aruna-background.jpeg'

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

// State
const inputUrl = ref<string>('https://rocrate.s3.computational.bio.uni-giessen.de/ro-crate-metadata.json')
const currentUrl = ref<string | null>(null)
const crate = ref<ROCrate | undefined>(undefined)
const currentCrateName = ref<string>('Root')

const historyStack = ref<HistoryItem[]>([])
const allEntities = ref<Array<any>>([])

// Selection State
const selectedEntityId = ref<string>('./')
const selectedEntityData = ref<{
  id: string;
  type: string;
  otherProps: Array<string>;
} | null>(null)

// UI State
const isDetailOverlayOpen = ref(false)
const linkedEntityData = ref<any>(null)
const fullCrateJson = ref<string | null>(null)
const isLoading = ref(false)
const baseUrl = ref<string>('')
const errorMsg = ref<string | null>(null)

// Theme State
const isDark = ref(true)

const toggleTheme = () => {
  isDark.value = !isDark.value
  if (isDark.value) {
    document.documentElement.classList.add('dark')
    localStorage.setItem('theme', 'dark')
  } else {
    document.documentElement.classList.remove('dark')
    localStorage.setItem('theme', 'light')
  }
}

// --- Helper: Name Extraction ---
const getSafeName = (entity: any, fallback: string) => {
  if (!entity) return fallback;

  let name = entity.name;
  if (Array.isArray(name) && name.length > 0) {
    name = name[0];
  }

  if (name && typeof name === 'string') return name;

  if (entity['@id']) return entity['@id'];

  return fallback;
}

// --- Helper: File Tree Generation (Graph Based) ---
const fileTree = computed(() => {
  let rootEntity = crate.value?.rootDataset || allEntities.value.find(e => e['@id'] === './' || e['@id'] === '.');

  if (!rootEntity) {
    return {
      name: currentCrateName.value,
      id: './',
      type: 'Dataset',
      children: [],
      data: null
    };
  }

  const entityMap = new Map<string, any>();
  allEntities.value.forEach(entity => {
    entityMap.set(entity['@id'], entity);
  });

  const getNodeName = (entity: any, id: string) => {
    if (entity && entity.name) return entity.name;
    const parts = id.split('/').filter(p => p && p !== '.');
    return parts[parts.length - 1] || id;
  };

  const buildTree = (entityId: string, visited: Set<string>): TreeNode => {
    const entity = entityMap.get(entityId);

    // Safety check: Loop detection
    if (visited.has(entityId)) {
      return {
        name: getNodeName(entity, entityId) + ' (Link)',
        id: entityId,
        type: 'Link',
        children: [],
        data: entity
      };
    }

    const currentVisited = new Set(visited);
    currentVisited.add(entityId);

    const children: TreeNode[] = [];

    if (entity && entity.hasPart) {
      const parts = Array.isArray(entity.hasPart) ? entity.hasPart : [entity.hasPart];

      parts.forEach((part: any) => {
        const partId = part['@id'] ? part['@id'] : part;
        if (typeof partId === 'string') {
          children.push(buildTree(partId, currentVisited));
        }
      });
    }

    children.sort((a, b) => {
      const aIsFolder = a.type === 'Dataset';
      const bIsFolder = b.type === 'Dataset';

      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.name.localeCompare(b.name);
    });

    let typeStr = 'File'; // Default
    if (entity && entity['@type']) {
      typeStr = Array.isArray(entity['@type']) ? entity['@type'][0] : entity['@type'];
    } else if (!entity) {
      typeStr = 'Broken Link';
    }

    return {
      name: getNodeName(entity, entityId),
      id: entityId,
      type: typeStr,
      children: children,
      data: entity || null
    };
  };

  return buildTree(rootEntity['@id'], new Set());
});

const otherEntitiesGroups = computed(() => {
  const groups: Record<string, any[]> = {};
  allEntities.value.forEach(entity => {
    const types = Array.isArray(entity['@type']) ? entity['@type'] : [entity['@type']];
    const isTreeItem = types.includes('File') || types.includes('Dataset');
    if (!isTreeItem) {
      const mainType = types[0] || 'Unknown';
      if (!groups[mainType]) groups[mainType] = [];
      groups[mainType].push(entity);
    }
  });
  return groups;
});

// --- Logic: Data Processing ---
const extractEntityData = (entity: any) => {
  if (!entity) return null;
  const { '@id': id, '@type': type, ...properties } = entity;
  const otherProps = Object.entries(properties).map(([key, value]) => {
    const isComplex = typeof value === 'object' && value !== null;
    const displayValue = isComplex ? JSON.stringify(value, null, 2) : String(value);
    return `${key}:\n${displayValue}`;
  });
  return { id, type: Array.isArray(type) ? type.join(', ') : type, otherProps };
};

const updateSelectedEntityView = () => {
  let entity = allEntities.value.find(e => e['@id'] === selectedEntityId.value);
  if (!entity && (selectedEntityId.value === './' || selectedEntityId.value === '.')) {
    entity = crate.value?.rootDataset || allEntities.value.find(e => e['@id'] === './' || e['@id'] === '.');
  }
  if (entity) {
    selectedEntityData.value = extractEntityData(entity);
  } else {
    selectedEntityData.value = null;
  }
};

const processCrateData = (json: any, sourceName: string, sourceUrl: string | null = null) => {
  try {
    allEntities.value = [];
    selectedEntityId.value = './';
    selectedEntityData.value = null;
    errorMsg.value = null;

    try {
      crate.value = new ROCrate(json, { array: true, link: true });
    } catch (e) {
      console.warn("Library parse error, using raw:", e);
    }

    allEntities.value = json['@graph'] || [];
    fullCrateJson.value = JSON.stringify(json, null, 2);
    currentUrl.value = sourceUrl;

    const rootEntity = allEntities.value.find(e => e['@id'] === './' || e['@id'] === '.') || crate.value?.rootDataset;
    currentCrateName.value = getSafeName(rootEntity, sourceName);

    updateSelectedEntityView();
  } catch (e: any) {
    console.error(e);
    errorMsg.value = "Failed to process RO-Crate JSON: " + e.message;
    allEntities.value = [];
  }
}

// --- Logic: Loading Sources ---
const loadFromUrl = async () => {
  if (!inputUrl.value) return;
  isLoading.value = true;
  errorMsg.value = null;

  try {
    let fetchUrl = inputUrl.value;
    if (!fetchUrl.toLowerCase().endsWith('.json')) {
      fetchUrl = fetchUrl.endsWith('/') ? fetchUrl + 'ro-crate-metadata.json' : fetchUrl + '/ro-crate-metadata.json';
    }

    const urlObj = new URL(fetchUrl);
    const pathParts = urlObj.pathname.split('/');
    if (pathParts[pathParts.length - 1].includes('.json')) pathParts.pop();
    urlObj.pathname = pathParts.join('/') + '/';
    baseUrl.value = urlObj.href;

    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();

    processCrateData(json, 'Remote Crate', fetchUrl);

  } catch (e: any) {
    errorMsg.value = `Error loading URL: ${e.message}`;
  } finally {
    isLoading.value = false;
  }
};

const handleFileUpload = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;
  const file = target.files[0];

  isLoading.value = true;
  errorMsg.value = null;
  baseUrl.value = '';

  try {
    let jsonContent = null;

    if (file.name.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(file);
      let metadataFile = zip.file('ro-crate-metadata.json');
      if (!metadataFile) {
        const allFiles = Object.keys(zip.files);
        const foundPath = allFiles.find(p => p.endsWith('ro-crate-metadata.json') && !p.startsWith('__MACOSX'));
        if (foundPath) metadataFile = zip.file(foundPath);
      }
      if (!metadataFile) throw new Error("No 'ro-crate-metadata.json' found in ZIP.");
      const text = await metadataFile.async('string');
      jsonContent = JSON.parse(text);
    }
    else if (file.name.endsWith('.json')) {
      const text = await file.text();
      jsonContent = JSON.parse(text);
    }
    else {
      throw new Error("Unsupported file type. Please upload .json or .zip");
    }

    processCrateData(jsonContent, file.name, null);

  } catch (e: any) {
    errorMsg.value = `File error: ${e.message}`;
  } finally {
    isLoading.value = false;
    target.value = '';
  }
};

// --- Logic: Navigation & Actions ---
const selectEntity = (id: string) => {
  selectedEntityId.value = id;
  updateSelectedEntityView();
};

const handleSelectLink = (entityId: string) => {
  const entity = allEntities.value.find(e => e['@id'] === entityId);
  if (entity) {
    linkedEntityData.value = extractEntityData(entity);
    isDetailOverlayOpen.value = true;
  }
};

const handleSubcrateOpen = (subcrateId: string) => {
  if (!baseUrl.value) {
    alert("Subcrate navigation is currently only supported for URL-loaded crates.");
    return;
  }
  let nextUrl = new URL(subcrateId, baseUrl.value).href;
  if (!nextUrl.toLowerCase().endsWith('.json')) {
    if (!nextUrl.endsWith('/')) nextUrl += '/';
    nextUrl += 'ro-crate-metadata.json';
  }

  historyStack.value.push({ name: currentCrateName.value, url: currentUrl.value });
  inputUrl.value = nextUrl;
  loadFromUrl();
};

const goToBreadcrumb = (index: number) => {
  const target = historyStack.value[index];
  if (target.url) {
    historyStack.value = historyStack.value.slice(0, index);
    inputUrl.value = target.url;
    loadFromUrl();
  }
}

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
  historyStack.value = [];
  currentUrl.value = null;
  errorMsg.value = null;
};

onMounted(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const crateUrlParam = urlParams.get('crateUrl');
  if (crateUrlParam) {
    inputUrl.value = decodeURIComponent(crateUrlParam);
    loadFromUrl();
  }

  // Theme Init
  const storedTheme = localStorage.getItem('theme')
  if (storedTheme === 'light') {
    isDark.value = false
    document.documentElement.classList.remove('dark')
  } else {
    isDark.value = true
    document.documentElement.classList.add('dark')
  }
})
</script>

<template>
  <div class="flex flex-col min-h-screen pb-10 relative isolate bg-[var(--c-bg-app)] text-[var(--c-text-muted)] transition-colors duration-300">

    <img
      :src="arunaBg"
      alt=""
      class="fixed inset-0 w-full h-full object-cover -z-10 opacity-10 pointer-events-none"
    />

    <div class="w-full border-b border-[var(--c-border)] bg-[var(--c-bg-card)]/90 backdrop-blur-sm shadow-sm flex justify-center px-4 md:px-6 transition-colors duration-300">
      <div class="w-full max-w-[1600px] py-4 flex justify-between items-center">
        <h1 class="text-3xl font-light text-[var(--c-text-main)] cursor-pointer select-none hover:text-[#00A0CC] transition-colors" @click="resetApp">
          RO-Crate Explorer
        </h1>
        <div class="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            class="h-9 w-9 p-0 rounded-full border border-[var(--c-border)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]"
            @click="toggleTheme"
          >
            <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
          </Button>
          <Button v-if="allEntities.length > 0" variant="secondary" size="sm" class="bg-[var(--c-hover)] text-[var(--c-text-main)] hover:bg-[#00A0CC] hover:text-white border border-[var(--c-border)]" @click="resetApp">
            Load New Crate
          </Button>
        </div>
      </div>
    </div>

    <div class="flex-grow w-full px-4 md:px-6 pt-6 flex flex-col items-center">

      <div v-if="errorMsg" class="w-full max-w-4xl bg-red-900/20 border border-red-800 text-red-400 px-4 py-3 rounded mb-6" role="alert">
        <span class="block sm:inline">{{ errorMsg }}</span>
      </div>

      <div v-if="allEntities.length === 0 && !isLoading" class="flex-grow flex flex-col items-center justify-center w-full max-w-5xl">
        <Card class="w-full max-w-xl shadow-xl bg-[var(--c-bg-card)] border-[var(--c-border)]">
          <CardHeader>
            <CardTitle class="text-2xl text-center text-[var(--c-text-main)]">Load RO-Crate</CardTitle>
            <CardDescription class="text-center text-[var(--c-text-muted)]">Upload a ZIP/JSON file or provide a URL.</CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-8 p-8">
            <div class="space-y-3">
              <label class="text-sm font-semibold text-[var(--c-text-muted)] block text-center">Upload File</label>
              <div class="flex items-center justify-center w-full">
                <label for="dropzone-file" class="flex flex-col items-center justify-center w-full h-40 border-2 border-[var(--c-border)] border-dashed rounded-lg cursor-pointer bg-[var(--c-bg-app)] hover:bg-[var(--c-hover)] transition-colors group">
                  <div class="flex flex-col items-center justify-center pt-5 pb-6 text-center">
                    <p class="text-sm text-[var(--c-text-muted)] group-hover:text-[var(--c-text-main)] transition-colors"><span class="font-semibold text-[#00A0CC]">Click to upload</span> or drag and drop</p>
                    <p class="text-xs text-[var(--c-text-muted)]/60 mt-1">.zip archive or .json metadata</p>
                  </div>
                  <input id="dropzone-file" type="file" class="hidden" accept=".json,.zip" @change="handleFileUpload" />
                </label>
              </div>
            </div>
            <div class="relative">
              <div class="absolute inset-0 flex items-center"><span class="w-full border-t border-[var(--c-border)]" /></div>
              <div class="relative flex justify-center text-xs uppercase tracking-wider"><span class="bg-[var(--c-bg-card)] px-2 text-[var(--c-text-muted)]/60">Or load from URL</span></div>
            </div>
            <div class="flex w-full items-center space-x-2">
              <input v-model="inputUrl" type="text" class="flex h-11 w-full rounded-md border border-[var(--c-border)] bg-[var(--c-bg-app)] text-[var(--c-text-main)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00A0CC] placeholder:text-gray-500" placeholder="https://..." />
              <Button class="h-11 px-6 bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white" @click="loadFromUrl">Load</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <div v-if="isLoading" class="flex-grow flex flex-col items-center justify-center w-full">
        <div class="animate-spin rounded-full h-16 w-16 border-t-4 border-b-4 border-[#00A0CC] mb-6"></div>
        <p class="text-xl text-[var(--c-text-muted)] font-light">Processing Crate...</p>
      </div>

      <div v-if="allEntities.length > 0 && !isLoading" class="w-full max-w-[1600px] flex flex-col gap-4 h-[80vh]">

        <div class="w-full bg-[var(--c-bg-card)] border border-[var(--c-border)] text-[var(--c-text-muted)] rounded-md p-3 flex items-center gap-4 shadow-sm">
          <Button variant="outline" size="sm" @click="goBack" :disabled="historyStack.length === 0" class="flex items-center gap-1 border-[var(--c-border)] bg-[var(--c-bg-app)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg> Back
          </Button>
          <nav class="flex items-center flex-wrap text-sm text-[var(--c-text-muted)]">
            <template v-for="(item, index) in historyStack" :key="index">
              <button @click="goToBreadcrumb(index)" class="hover:text-[#00A0CC] font-medium px-1 cursor-pointer">{{ item.name }}</button>
              <span class="text-[var(--c-text-muted)]/40 mx-1">/</span>
            </template>
            <span class="font-bold text-[#00A0CC] px-1">{{ currentCrateName }}</span>
          </nav>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6 h-full overflow-hidden pb-2 w-full">
          <aside class="col-span-1 bg-[var(--c-bg-card)] border border-[var(--c-border)] rounded-lg shadow-sm flex flex-col h-full overflow-hidden transition-colors duration-300">
            <div class="p-3 bg-[var(--c-bg-app)] border-b border-[var(--c-border)] flex-shrink-0"><h2 class="text-xs font-bold text-[var(--c-text-muted)]/80 uppercase tracking-wider">Files</h2></div>
            <div class="flex-1 overflow-y-auto p-2">
              <FileTreeItem :node="fileTree" :selectedId="selectedEntityId" @select="selectEntity" />
            </div>
            <div class="h-1 bg-[var(--c-bg-app)] border-t border-b border-[var(--c-border)]"></div>
            <div class="p-3 bg-[var(--c-bg-app)] border-b border-[var(--c-border)] flex-shrink-0"><h2 class="text-xs font-bold text-[var(--c-text-muted)]/80 uppercase tracking-wider">Context</h2></div>
            <div class="flex-1 overflow-y-auto p-2">
              <div v-for="(entities, groupName) in otherEntitiesGroups" :key="groupName" class="mb-4">
                <h3 class="text-[10px] font-bold text-[#00A0CC] uppercase mb-1 px-2 tracking-widest">{{ groupName }}</h3>
                <div class="flex flex-col gap-[1px]">
                  <button v-for="entity in entities" :key="entity['@id']" @click="selectEntity(entity['@id'])" :class="['text-left px-2 py-1 text-sm rounded-sm hover:bg-[var(--c-hover)] transition-all truncate border-l-2 w-full', selectedEntityId === entity['@id'] ? 'bg-[var(--c-hover)] text-[#00A0CC] border-[#00A0CC] font-medium shadow-sm' : 'text-[var(--c-text-muted)] border-transparent']" :title="entity['@id']">{{ entity['name'] || entity['@id'] }}</button>
                </div>
              </div>
            </div>
          </aside>

          <main class="col-span-1 flex flex-col h-full overflow-hidden min-w-0">
            <div class="flex-1 h-full min-h-0 pr-1">
              <RoCrateEntity v-if="selectedEntityData" :id="selectedEntityData.id" :type="selectedEntityData.type" :otherProps="selectedEntityData.otherProps" :fullCrateJson="fullCrateJson" @select-link="handleSelectLink" @open-subcrate="handleSubcrateOpen" class="w-full" />
              <div v-else class="h-full flex flex-col items-center justify-center bg-[var(--c-bg-card)] border border-dashed border-[var(--c-border)] rounded-lg text-[var(--c-text-muted)]/50 transition-colors duration-300"><p>Select an entity to view details.</p></div>
            </div>
          </main>
        </div>
      </div>
    </div>

    <AlertDialog :open="isDetailOverlayOpen" @update:open="isDetailOverlayOpen = $event">
      <AlertDialogContent class="text-[var(--c-text-muted)] bg-[var(--c-bg-card)] border-[var(--c-border)] max-w-4xl max-h-[80vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle class="flex items-center gap-2 text-[var(--c-text-main)]"><span class="bg-[var(--c-hover)] text-[#00A0CC] text-xs px-2 py-0.5 rounded uppercase">Linked Entity</span> {{ linkedEntityData?.id }}</AlertDialogTitle>
          <AlertDialogDescription class="text-[var(--c-text-muted)]/80">Type: {{ linkedEntityData?.type }}</AlertDialogDescription>
        </AlertDialogHeader>
        <div v-if="linkedEntityData" class="p-1 flex flex-col gap-1.5">
          <div v-for="(propString, index) in linkedEntityData.otherProps" :key="index" class="p-3 bg-[var(--c-bg-app)] rounded border border-[var(--c-border)] text-sm">
            <div class="font-bold text-[var(--c-text-muted)] text-xs uppercase mb-1">{{ propString.split(':\n')[0] }}</div>
            <div class="whitespace-pre-wrap font-mono text-xs text-[var(--c-text-muted)]/80">{{ propString.split(':\n')[1] }}</div>
          </div>
        </div>
        <AlertDialogFooter><AlertDialogAction class="bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white" @click="isDetailOverlayOpen = false">Close</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

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