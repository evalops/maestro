/**
 * useComposer Hook
 *
 * Manages global Composer state including sessions, models, and settings.
 */

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../lib/api-client";
import type { Model, Session, SessionSummary } from "../lib/types";

const getModelKey = (model: Model) => `${model.provider}:${model.id}`;

const dedupeModels = (list: Model[]) => {
	const seen = new Set<string>();
	return list.filter((model) => {
		const key = getModelKey(model);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const parseModelSpecifier = (specifier: string) => {
	const trimmed = specifier.trim();
	const [provider, ...rest] = trimmed.split(":");
	if (rest.length === 0) {
		return { provider: undefined, id: trimmed };
	}
	return { provider, id: rest.join(":") };
};

export interface UseComposerReturn {
	// Sessions
	sessions: SessionSummary[];
	loading: boolean;
	createSession: (title?: string) => Promise<Session | null>;
	deleteSession: (sessionId: string) => Promise<void>;
	refreshSessions: () => Promise<void>;

	// Models
	models: Model[];
	currentModel: Model | null;
	setModel: (modelId: string) => Promise<void>;
}

export function useComposer(): UseComposerReturn {
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [models, setModels] = useState<Model[]>([]);
	const [currentModel, setCurrentModel] = useState<Model | null>(null);
	const [loading, setLoading] = useState(true);

	// Load initial data
	useEffect(() => {
		const loadData = async () => {
			setLoading(true);
			try {
				const [sessionsData, modelsData, modelData] = await Promise.all([
					apiClient.getSessions(),
					apiClient.getModels(),
					apiClient.getCurrentModel(),
				]);

				setSessions(sessionsData);
				setModels(dedupeModels(modelsData));
				setCurrentModel(modelData);
			} catch (err) {
				console.error("Failed to load initial data:", err);
			} finally {
				setLoading(false);
			}
		};

		loadData();
	}, []);

	const refreshSessions = useCallback(async () => {
		try {
			const sessionsData = await apiClient.getSessions();
			setSessions(sessionsData);
		} catch (err) {
			console.error("Failed to refresh sessions:", err);
		}
	}, []);

	const createSession = useCallback(async (title?: string) => {
		try {
			const session = await apiClient.createSession(title);
			setSessions((prev) => [
				{
					id: session.id,
					title: session.title,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					messageCount: 0,
				},
				...prev,
			]);
			return session;
		} catch (err) {
			console.error("Failed to create session:", err);
			return null;
		}
	}, []);

	const deleteSession = useCallback(async (sessionId: string) => {
		try {
			await apiClient.deleteSession(sessionId);
			setSessions((prev) => prev.filter((s) => s.id !== sessionId));
		} catch (err) {
			console.error("Failed to delete session:", err);
		}
	}, []);

	const setModel = useCallback(
		async (modelId: string) => {
			try {
				await apiClient.setModel(modelId);
				const parsed = parseModelSpecifier(modelId);
				const model = models.find((m) =>
					parsed.provider
						? m.provider === parsed.provider && m.id === parsed.id
						: m.id === parsed.id,
				);
				if (model) {
					setCurrentModel(model);
					return;
				}
				const refreshed = await apiClient.getCurrentModel();
				setCurrentModel(refreshed);
			} catch (err) {
				console.error("Failed to set model:", err);
			}
		},
		[models],
	);

	return {
		sessions,
		loading,
		createSession,
		deleteSession,
		refreshSessions,
		models,
		currentModel,
		setModel,
	};
}
