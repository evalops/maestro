import { useCallback, useEffect, useState } from "react";
import type {
	AutomationCreateInput,
	AutomationUpdateInput,
} from "../lib/api-client";
import { apiClient } from "../lib/api-client";
import type { AutomationTask } from "../lib/types";

export interface UseAutomationsReturn {
	automations: AutomationTask[];
	loading: boolean;
	refreshAutomations: () => Promise<void>;
	createAutomation: (
		input: AutomationCreateInput,
	) => Promise<AutomationTask | null>;
	updateAutomation: (
		id: string,
		input: AutomationUpdateInput,
	) => Promise<AutomationTask | null>;
	deleteAutomation: (id: string) => Promise<void>;
	runAutomation: (id: string) => Promise<AutomationTask | null>;
}

export function useAutomations(): UseAutomationsReturn {
	const [automations, setAutomations] = useState<AutomationTask[]>([]);
	const [loading, setLoading] = useState(true);

	const refreshAutomations = useCallback(async () => {
		try {
			const data = await apiClient.getAutomations();
			setAutomations(data);
		} catch (error) {
			console.error("Failed to load automations:", error);
		}
	}, []);

	useEffect(() => {
		setLoading(true);
		refreshAutomations()
			.catch(() => undefined)
			.finally(() => setLoading(false));
	}, [refreshAutomations]);

	const createAutomation = useCallback(async (input: AutomationCreateInput) => {
		try {
			const created = await apiClient.createAutomation(input);
			setAutomations((prev) => [created, ...prev]);
			return created;
		} catch (error) {
			console.error("Failed to create automation:", error);
			return null;
		}
	}, []);

	const updateAutomation = useCallback(
		async (id: string, input: AutomationUpdateInput) => {
			try {
				const updated = await apiClient.updateAutomation(id, input);
				setAutomations((prev) =>
					prev.map((item) => (item.id === id ? updated : item)),
				);
				return updated;
			} catch (error) {
				console.error("Failed to update automation:", error);
				return null;
			}
		},
		[],
	);

	const deleteAutomation = useCallback(async (id: string) => {
		try {
			await apiClient.deleteAutomation(id);
			setAutomations((prev) => prev.filter((item) => item.id !== id));
		} catch (error) {
			console.error("Failed to delete automation:", error);
		}
	}, []);

	const runAutomation = useCallback(async (id: string) => {
		try {
			const updated = await apiClient.runAutomation(id);
			setAutomations((prev) =>
				prev.map((item) => (item.id === id ? updated : item)),
			);
			return updated;
		} catch (error) {
			console.error("Failed to run automation:", error);
			return null;
		}
	}, []);

	return {
		automations,
		loading,
		refreshAutomations,
		createAutomation,
		updateAutomation,
		deleteAutomation,
		runAutomation,
	};
}
