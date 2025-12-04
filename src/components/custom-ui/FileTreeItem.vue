<script setup lang="ts">
import { ref, computed } from 'vue'

interface TreeNode {
  name: string;
  id: string;
  type: string;
  children: TreeNode[];
  data: any;
}

const props = defineProps<{
  node: TreeNode;
  selectedId: string;
  depth?: number;
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
}>()

const isOpen = ref(false)

const indentStyle = computed(() => {
  return { paddingLeft: `${(props.depth || 0) * 12 + 8}px` }
})

const isFolder = computed(() => {
  return (props.node.children && props.node.children.length > 0) || props.node.type === 'Dataset';
})

const toggle = () => {
  if (isFolder.value) {
    isOpen.value = !isOpen.value;
    emit('select', props.node.id);
  } else {
    emit('select', props.node.id);
  }
}

const onSelect = (id: string) => {
  emit('select', id)
}
</script>

<template>
  <div class="w-full font-medium text-sm">
    <button
      @click="toggle"
      :class="[
        'w-full text-left py-1.5 pr-2 flex items-center gap-2 hover:bg-[var(--c-hover)] transition-colors duration-150 border-l-2 relative group',
        selectedId === node.id
          ? 'bg-[var(--c-hover)] border-[#00A0CC] text-[#00A0CC] font-semibold'
          : 'border-transparent text-[var(--c-text-muted)]'
      ]"
      :style="indentStyle"
      :title="node.name"
    >
      <span class="text-[var(--c-text-muted)]/60 flex-shrink-0 w-4 flex justify-center">
        <svg v-if="isFolder" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>
        </svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </span>

      <span class="truncate min-w-0 flex-1">{{ node.name }}</span>

      <span v-if="isFolder" class="ml-auto text-xs text-[var(--c-text-muted)]/60 flex-shrink-0 pl-2">
        {{ isOpen ? '▼' : '▶' }}
      </span>
    </button>

    <div v-if="isOpen && isFolder" class="w-full">
      <FileTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :selectedId="selectedId"
        :depth="(depth || 0) + 1"
        @select="onSelect"
      />
    </div>
  </div>
</template>