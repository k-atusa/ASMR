/// <reference types="vite/client" />

declare interface ImportMetaEnv {
  readonly ICECAST_BASE_URL?: string
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv
}
