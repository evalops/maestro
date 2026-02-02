/**
 * useComposer Hook
 *
 * Manages global Composer state including sessions, models, and settings.
 */

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../lib/api-client";
import type { Model, Session, SessionSummary } from "../lib/types";

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
				setModels(modelsData);
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
				const model = models.find((m) => m.id === modelId);
				if (model) {
					setCurrentModel(model);
				}
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
