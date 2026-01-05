export const config = {
  buildMode: import.meta.env.VITE_BUILD_MODE || 'stateless',
  indexingServiceUrl: import.meta.env.VITE_INDEXING_SERVICE_URL || '',
  corsProxyUrl: import.meta.env.VITE_CORS_PROXY_URL || 'https://cors.aruna-engine.org/',

  get isStateless(): boolean {
    return this.buildMode !== 'stateful'
  },

  features: {
    get remoteSearch(): boolean {
      return config.buildMode === 'stateful' && !!config.indexingServiceUrl
    },
    get localSearch(): boolean {
      return true // Always available
    },
    get remoteIndexing(): boolean {
      return config.buildMode === 'stateful' && !!config.indexingServiceUrl
    }
  }
}
