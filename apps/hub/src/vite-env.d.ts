/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_HUB_API?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
