/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BUILD_MODE?: 'stateless' | 'stateful'
  readonly VITE_INDEXING_SERVICE_URL?: string
  readonly VITE_CORS_PROXY_URL?: string
  readonly BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
