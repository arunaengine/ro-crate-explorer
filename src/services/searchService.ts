import Fuse, { type IFuseOptions } from 'fuse.js';

/**
 * Interface for items stored in the search index
 */
interface SearchIndexItem {
  entityId: string;
  crateId: string;
  searchableContent: string;
}

/**
 * Interface for search results returned by localSearch
 */
export interface SearchResult {
  entityId: string;
  crateId: string;
}

/**
 * Type for RO-Crate entities (flexible to handle any JSON-LD entity)
 */
type RoCrateEntity = Record<string, any>;

/**
 * Fuse.js instance for fuzzy search
 */
let fuseInstance: Fuse<SearchIndexItem> | null = null;

/**
 * The underlying index data
 */
let indexData: SearchIndexItem[] = [];

/**
 * Fuse.js configuration options
 */
const FUSE_OPTIONS: IFuseOptions<SearchIndexItem> = {
  keys: ['searchableContent'],
  threshold: 0.3, // 0.0 = exact match, 1.0 = match anything
  ignoreLocation: true, // Don't care where in the text the match occurs
  minMatchCharLength: 2, // Minimum character length for matching
  shouldSort: true, // Sort results by score
  includeScore: true, // Include match score in results
};

/**
 * Recursively flatten nested objects and arrays into a single searchable string.
 * This ensures all string values from all keys are indexed, regardless of nesting depth.
 *
 * @param value - Any value from an entity (string, number, object, array, etc.)
 * @param depth - Current recursion depth (prevents infinite loops)
 * @param maxDepth - Maximum recursion depth
 * @returns A flattened string representation of the value
 */
function flattenValue(value: any, depth: number = 0, maxDepth: number = 10): string {
  if (depth > maxDepth) {
    return '';
  }

  if (value === null || value === undefined) {
    return '';
  }

  // Handle primitives
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value
      .map(item => flattenValue(item, depth + 1, maxDepth))
      .filter(s => s.length > 0)
      .join(' ');
  }

  // Handle objects
  if (typeof value === 'object') {
    const parts: string[] = [];

    for (const [key, val] of Object.entries(value)) {
      // Include both the key name and its value
      // This ensures we can search for property names too
      if (key && key !== '@context') { // Skip @context as it's usually not useful for search
        parts.push(key);
        const flattenedVal = flattenValue(val, depth + 1, maxDepth);
        if (flattenedVal) {
          parts.push(flattenedVal);
        }
      }
    }

    return parts.join(' ');
  }

  return '';
}

/**
 * Extract all searchable content from an entity.
 * This indexes ALL keys and their values, not just predefined ones.
 *
 * @param entity - RO-Crate entity object
 * @returns A single string containing all searchable content
 */
function extractSearchableContent(entity: RoCrateEntity): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(entity)) {
    // Skip @context as it's usually not useful for search
    if (key === '@context') {
      continue;
    }

    // Include the key itself (property names are searchable)
    parts.push(key);

    // Include the flattened value
    const flattenedValue = flattenValue(value);
    if (flattenedValue) {
      parts.push(flattenedValue);
    }
  }

  // Join all parts with spaces and normalize whitespace
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build or rebuild the search index from scratch.
 * This should be called when the primary crate is loaded.
 *
 * @param entities - Array of RO-Crate entities from the @graph
 * @param crateId - Optional crate identifier (defaults to 'primary')
 */
export function buildSearchIndex(entities: RoCrateEntity[], crateId: string = 'primary'): void {
  // Clear existing index
  indexData = [];

  // Build new index data
  for (const entity of entities) {
    const entityId = entity['@id'];
    if (!entityId) {
      continue; // Skip entities without @id
    }

    const searchableContent = extractSearchableContent(entity);
    if (searchableContent) {
      indexData.push({
        entityId,
        crateId,
        searchableContent,
      });
    }
  }

  // Create new Fuse instance
  fuseInstance = new Fuse(indexData, FUSE_OPTIONS);
}

/**
 * Add entities from a subcrate to the existing index.
 * This appends to the current index without rebuilding from scratch.
 * If entities from the same crateId already exist, they will be replaced.
 *
 * @param entities - Array of RO-Crate entities from the subcrate's @graph
 * @param crateId - Crate identifier for the subcrate
 */
export function addToIndex(entities: RoCrateEntity[], crateId: string): void {
  if (!fuseInstance) {
    // If no index exists yet, build it
    buildSearchIndex(entities, crateId);
    return;
  }

  // Remove existing entries for this crateId to avoid duplicates
  indexData = indexData.filter(item => item.crateId !== crateId);

  // Add new entities to the index data
  for (const entity of entities) {
    const entityId = entity['@id'];
    if (!entityId) {
      continue;
    }

    const searchableContent = extractSearchableContent(entity);
    if (searchableContent) {
      indexData.push({
        entityId,
        crateId,
        searchableContent,
      });
    }
  }

  // Rebuild Fuse instance with updated data
  fuseInstance = new Fuse(indexData, FUSE_OPTIONS);
}

/**
 * Perform a local fuzzy search across all indexed entities.
 *
 * @param query - Search query string
 * @param limit - Maximum number of results to return (defaults to 50)
 * @returns Array of search results with entityId and crateId
 */
export function localSearch(query: string, limit: number = 50): SearchResult[] {
  if (!fuseInstance || !query || query.trim().length === 0) {
    return [];
  }

  const results = fuseInstance.search(query, { limit });

  return results.map(result => ({
    entityId: result.item.entityId,
    crateId: result.item.crateId,
  }));
}

/**
 * Clear the search index completely.
 * This should be called when resetting the application or loading a new crate.
 */
export function clearSearchIndex(): void {
  fuseInstance = null;
  indexData = [];
}
