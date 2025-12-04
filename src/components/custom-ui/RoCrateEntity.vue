<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { computed, ref } from 'vue'

let props = defineProps<{
  id: string
  type: string
  otherProps: Array<string>
  fullCrateJson: string | null
}>()

const emit = defineEmits<{
  (e: 'select-link', id: string): void
  (e: 'open-subcrate', id: string): void
}>()

const isCopied = ref(false)

const knownEntityIds = computed(() => {
  if (!props.fullCrateJson) return new Set<string>();
  try {
    const json = JSON.parse(props.fullCrateJson);
    const graph = json['@graph'] || [];
    return new Set(graph.map((node: any) => node['@id']));
  } catch (e) {
    return new Set<string>();
  }
});

const isKnownEntity = (id: string) => {
  return knownEntityIds.value.has(id);
};

const getKey = (propString: string) => {
  const separatorIndex = propString.indexOf(':\n');
  return separatorIndex !== -1 ? propString.substring(0, separatorIndex).trim() : propString;
};

const getValue = (propString: string) => {
  const separatorIndex = propString.indexOf(':\n');
  const rawValue = separatorIndex !== -1 ? propString.substring(separatorIndex + 2).trim() : '';

  try {
    const jsonValue = JSON.parse(rawValue);
    return jsonValue;
  } catch (e) {
  }

  return rawValue;
};

const isSubcrateLink = (key: string, value: any): boolean => {
  if (key.toLowerCase() === 'subjectof') {
    const valToCheck = Array.isArray(value) ? value[0] : value;
    if (valToCheck && valToCheck['@id'] && valToCheck['@id'].includes('ro-crate-metadata.json')) {
      return true;
    }
  }

  const valToCheck = Array.isArray(value) ? value[0] : value;
  if (typeof valToCheck === 'object' && valToCheck !== null && valToCheck['@id']) {
    if (valToCheck['@id'].endsWith('ro-crate-metadata.json')) {
      return true;
    }
  }

  return false;
};

// Helper to check if a string is a valid HTTP/HTTPS URL
const isUrl = (str: any): boolean => {
  if (typeof str !== 'string') return false;
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const onLinkClick = (entityId: string) => {
  emit('select-link', entityId);
};

const onSubcrateOpen = (subcrateId: string) => {
  emit('open-subcrate', subcrateId);
};

function displayRaw() {
  if (props.fullCrateJson) {
    return props.fullCrateJson
  }
  let json_obj = {};
  json_obj['@id'] = props.id;
  json_obj['@type'] = props.type;

  return JSON.stringify(json_obj, null, 2);
}

const copyRawJson = async () => {
  const text = displayRaw();
  try {
    await navigator.clipboard.writeText(text);
    isCopied.value = true;
    setTimeout(() => {
      isCopied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

const normalizeValues = (val: any) => {
  return Array.isArray(val) ? val : [val];
}
</script>

<template>
  <Card class="w-full min-w-0 flex flex-col h-full overflow-hidden shadow-sm bg-[var(--c-bg-card)] border border-[var(--c-border)] rounded-lg transition-colors duration-300">
    <CardHeader class="p-3 border-b border-[var(--c-border)] flex-shrink-0">
      <div class="flex justify-between items-start gap-4">
        <div class="min-w-0 flex-1">
          <CardDescription class="text-xs font-bold uppercase tracking-wider text-[#00A0CC] mb-0.5">
            {{ type }}
          </CardDescription>
          <CardTitle class="text-lg text-[var(--c-text-main)] break-all leading-tight font-medium">
            {{ id }}
          </CardTitle>
        </div>
        <CardAction class="flex-shrink-0">
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button variant="ghost" size="sm" class="h-8 w-8 p-0 text-[var(--c-text-muted)] hover:text-[var(--c-text-main)] hover:bg-[var(--c-hover)]">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14 2z"/><polyline points="14 2 14 8 20 8"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
                <span class="sr-only">Raw JSON</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent class="text-[var(--c-text-muted)] bg-[var(--c-bg-card)] border-[var(--c-border)] max-w-4xl max-h-[80vh] overflow-y-auto">
              <AlertDialogHeader>
                <div class="flex items-center justify-between">
                  <AlertDialogTitle class="text-[var(--c-text-main)]">Raw JSON-LD</AlertDialogTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-8 border-[var(--c-border)] bg-[var(--c-bg-app)] hover:bg-[var(--c-hover)] text-[var(--c-text-muted)] hover:text-[var(--c-text-main)] flex items-center gap-2"
                    @click="copyRawJson"
                  >
                    <span v-if="!isCopied" class="flex items-center gap-2">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                      Copy JSON
                    </span>
                    <span v-else class="flex items-center gap-2 text-green-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                      Copied!
                    </span>
                  </Button>
                </div>
                <AlertDialogDescription class="text-[var(--c-text-muted)]/60">Full source representation.</AlertDialogDescription>
              </AlertDialogHeader>
              <pre class="whitespace-pre-wrap text-xs bg-[var(--c-bg-app)] text-[var(--c-text-muted)] p-4 rounded-md font-mono overflow-x-auto border border-[var(--c-border)]">{{ displayRaw() }}</pre>
              <AlertDialogFooter>
                <AlertDialogAction class="bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white">Close</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardAction>
      </div>
    </CardHeader>

    <CardContent class="flex-1 overflow-y-auto flex flex-col gap-0 p-0">
      <div
        v-for="(propString, index) in props.otherProps"
        :key="index"
        class="flex flex-col sm:flex-row border-b border-[var(--c-border)] last:border-0 hover:bg-[var(--c-hover)] transition-colors group"
      >
        <div class="w-full sm:w-1/4 min-w-[120px] p-3 text-sm font-semibold text-[var(--c-text-muted)] bg-[var(--c-bg-app)]/50 break-words">
          {{ getKey(propString) }}
        </div>

        <div class="w-full sm:w-3/4 p-3 text-sm text-[var(--c-text-muted)] break-words min-w-0">

          <template v-if="typeof getValue(propString) === 'object' && getValue(propString) !== null">
            <div class="flex flex-col gap-2">
              <div v-for="(item, i) in normalizeValues(getValue(propString))" :key="i" class="min-w-0">

                <div v-if="isSubcrateLink(getKey(propString), item)" class="flex items-center gap-2 p-2 bg-[var(--c-bg-app)] rounded border border-[var(--c-border)]">
                  <span class="text-[#00A0CC] font-medium break-all flex-1 min-w-0">{{ item['@id'] }}</span>
                  <Button
                    size="sm"
                    class="bg-[#00A0CC] hover:bg-[#00A0CC]/80 text-white flex-shrink-0 h-7 text-xs whitespace-nowrap"
                    @click="onSubcrateOpen(item['@id'])"
                  >
                    Explore Subcrate
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ml-1"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </Button>
                </div>

                <div v-else-if="item['@id'] && isKnownEntity(item['@id'])" class="flex flex-wrap items-center gap-2">
                  <div class="inline-flex items-center bg-[var(--c-hover)]/40 border border-[var(--c-border)] rounded-md overflow-hidden max-w-full hover:bg-[var(--c-hover)] transition-colors group/pill">
                    <Button
                      variant="ghost"
                      class="h-auto py-1 px-2 text-[#00A0CC] group-hover/pill:text-[var(--c-text-main)] break-all text-left font-normal whitespace-normal rounded-none"
                      @click="onLinkClick(item['@id'])"
                      title="View Entity Details (Internal)"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1.5 opacity-70"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                      {{ item['@id'] }}
                    </Button>
                    <template v-if="isUrl(item['@id'])">
                      <div class="w-px h-4 bg-[var(--c-border)] mx-0 group-hover/pill:bg-[#00A0CC]/30"></div>
                      <a
                        :href="item['@id']"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="px-2 py-1 text-[var(--c-text-muted)] hover:text-[#00A0CC] hover:bg-[var(--c-bg-app)] transition-colors flex items-center h-full"
                        title="Open External Source"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      </a>
                    </template>
                  </div>
                  <span v-if="item['@type']" class="text-xs text-[var(--c-text-muted)]/80 border border-[var(--c-border)] px-1 rounded bg-[var(--c-bg-app)] whitespace-nowrap">
                      {{ Array.isArray(item['@type']) ? item['@type'][0] : item['@type'] }}
                  </span>
                </div>

                <div v-else-if="item['@id'] && isUrl(item['@id'])" class="flex items-center gap-2">
                  <a
                    :href="item['@id']"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-[var(--c-text-muted)] hover:text-[#00A0CC] hover:underline break-all flex items-center gap-1.5"
                  >
                    {{ item['@id'] }}
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-70"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                  <span v-if="item['@type']" class="text-xs text-[var(--c-text-muted)]/40 border border-[var(--c-border)] px-1 rounded bg-[var(--c-bg-app)] whitespace-nowrap">
                      {{ Array.isArray(item['@type']) ? item['@type'][0] : item['@type'] }}
                  </span>
                </div>

                <div v-else-if="item['@id']" class="text-sm text-red-400/70 font-mono break-all">
                  {{ item['@id'] }} <span class="text-xs opacity-50">(Unresolved)</span>
                </div>

                <div v-else class="bg-[var(--c-bg-app)] p-2 rounded text-xs font-mono overflow-x-auto border border-[var(--c-border)]">
                  {{ JSON.stringify(item, null, 2) }}
                </div>

              </div>
            </div>
          </template>

          <template v-else>
            <div v-if="isUrl(getValue(propString))" class="flex items-center gap-2">
              <a
                :href="getValue(propString)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-[var(--c-text-muted)] hover:text-[#00A0CC] hover:underline break-all flex items-center gap-1.5"
              >
                {{ getValue(propString) }}
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="opacity-70"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
            </div>
            <span v-else class="whitespace-pre-wrap break-words">
                {{ getValue(propString) }}
            </span>
          </template>

        </div>
      </div>
    </CardContent>

    <CardFooter class="p-2 text-[10px] text-[var(--c-text-muted)]/40 justify-center border-t border-[var(--c-border)] flex-shrink-0">
      Proudly presented by the team of Project 3
    </CardFooter>
  </Card>
</template>