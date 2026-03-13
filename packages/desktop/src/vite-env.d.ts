/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_COMPOSER_BASE_URL?: string;
	readonly VITE_COMPOSER_CSRF_TOKEN?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
