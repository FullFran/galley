/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the galley API. Defaults to http://127.0.0.1:8090. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
