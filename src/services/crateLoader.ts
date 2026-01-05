import JSZip from 'jszip'
import { config } from '@/config'

export interface RoCrateJson {
  '@context': string | object | (string | object)[]
  '@graph': any[]
}

/**
 * Validates that an object is a valid RO-Crate JSON structure
 */
function validateRoCrateJson(data: any): asserts data is RoCrateJson {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid RO-Crate: data is not an object')
  }

  if (!('@context' in data)) {
    throw new Error('Invalid RO-Crate: missing @context')
  }

  if (!('@graph' in data)) {
    throw new Error('Invalid RO-Crate: missing @graph')
  }

  if (!Array.isArray(data['@graph'])) {
    throw new Error('Invalid RO-Crate: @graph is not an array')
  }

  if (data['@graph'].length === 0) {
    throw new Error('Invalid RO-Crate: @graph is empty')
  }

  // Check for root dataset entity (./ or .)
  const hasRootDataset = data['@graph'].some(
    (entity: any) => entity?.['@id'] === './' || entity?.['@id'] === '.'
  )
  if (!hasRootDataset) {
    throw new Error('Invalid RO-Crate: missing root dataset entity with @id "./" or "."')
  }
}

/**
 * Fetches an RO-Crate from a URL using the configured CORS proxy
 * @param url - The URL to fetch the RO-Crate from
 * @returns Promise resolving to the parsed RO-Crate JSON
 * @throws Error if fetch fails, JSON is invalid, or RO-Crate is malformed
 */
export async function fetchCrateFromUrl(url: string): Promise<RoCrateJson> {
  try {
    // Construct CORS proxy URL
    const corsProxyUrl = config.corsProxyUrl.endsWith('/')
      ? config.corsProxyUrl
      : `${config.corsProxyUrl}/`
    const proxiedUrl = `${corsProxyUrl}${url}`

    // Fetch the crate
    const response = await fetch(proxiedUrl)

    if (!response.ok) {
      throw new Error(`Failed to fetch crate: ${response.status} ${response.statusText}`)
    }

    // Parse JSON
    let data: any
    try {
      data = await response.json()
    } catch (parseError) {
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`)
    }

    // Validate RO-Crate structure
    validateRoCrateJson(data)

    return data
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error fetching RO-Crate from URL: ${error.message}`)
    }
    throw new Error('Unknown error fetching RO-Crate from URL')
  }
}

/**
 * Loads an RO-Crate from a File object
 * Supports both JSON files and ZIP files containing ro-crate-metadata.json
 * @param file - The File object to load
 * @returns Promise resolving to the parsed RO-Crate JSON
 * @throws Error if file reading fails or RO-Crate is invalid
 */
export async function loadCrateFromFile(file: File): Promise<RoCrateJson> {
  try {
    // Check if file is a ZIP
    if (file.type === 'application/zip' || file.name.endsWith('.zip')) {
      return await extractFromZip(file)
    }

    // Otherwise, treat as JSON file
    const text = await readFileAsText(file)

    let data: any
    try {
      data = JSON.parse(text)
    } catch (parseError) {
      throw new Error(`Failed to parse JSON: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`)
    }

    // Validate RO-Crate structure
    validateRoCrateJson(data)

    return data
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error loading RO-Crate from file: ${error.message}`)
    }
    throw new Error('Unknown error loading RO-Crate from file')
  }
}

/**
 * Extracts ro-crate-metadata.json from a ZIP file
 * @param file - The ZIP File object
 * @returns Promise resolving to the parsed RO-Crate JSON
 * @throws Error if ZIP reading fails or ro-crate-metadata.json is not found
 */
export async function extractFromZip(file: File): Promise<RoCrateJson> {
  try {
    // Load ZIP file
    const zip = await JSZip.loadAsync(file)

    // Look for ro-crate-metadata.json
    // Check both root and any subdirectories
    let metadataFile = zip.file('ro-crate-metadata.json')

    if (!metadataFile) {
      // Try to find in subdirectories
      const files = Object.keys(zip.files)
      const metadataPath = files.find((path) => {
        const fileEntry = zip.files[path]
        return fileEntry && path.endsWith('ro-crate-metadata.json') && !fileEntry.dir
      })

      if (metadataPath) {
        metadataFile = zip.file(metadataPath)
      }
    }

    if (!metadataFile) {
      throw new Error('ro-crate-metadata.json not found in ZIP file')
    }

    // Extract and parse JSON
    const text = await metadataFile.async('text')

    let data: any
    try {
      data = JSON.parse(text)
    } catch (parseError) {
      throw new Error(`Failed to parse ro-crate-metadata.json: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`)
    }

    // Validate RO-Crate structure
    validateRoCrateJson(data)

    return data
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error extracting RO-Crate from ZIP: ${error.message}`)
    }
    throw new Error('Unknown error extracting RO-Crate from ZIP')
  }
}

/**
 * Helper function to read a File as text using FileReader API
 * @param file - The File object to read
 * @returns Promise resolving to the file contents as a string
 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Failed to read file as text'))
      }
    }

    reader.onerror = () => {
      reject(new Error(`File reading failed: ${reader.error?.message || 'Unknown error'}`))
    }

    reader.readAsText(file)
  })
}
