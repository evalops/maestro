/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_MAESTRO_BASE_URL?: string;
	readonly VITE_MAESTRO_CSRF_TOKEN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
