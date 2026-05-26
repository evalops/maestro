import { html } from "lit";
import type { McpRegistryImportRequest } from "../services/api-client.js";

// The MCP settings surface has a wide context by design: it renders and wires
// the existing ComposerSettings state without changing ownership.
// biome-ignore lint/suspicious/noExplicitAny: the extracted renderer mirrors existing private component state.
type ComposerSettingsMcpSectionContext = Record<string, any>;

export function renderComposerSettingsMcpSection(
	ctx: ComposerSettingsMcpSectionContext,
) {
	const servers = ctx.mcpStatus?.servers ?? [];
	const authPresets = ctx.getAvailableAuthPresets();

	return html`
			<div class="section">
				<div class="section-header">
					<h3>MCP</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<div>
							<div class="info-value">Auth Presets</div>
							<div class="info-label">
								Reusable hidden headers/helpers for remote MCP servers
							</div>
						</div>
					</div>
					${
						authPresets.length > 0
							? html`
								<div class="panel-grid" style="margin-bottom: 1rem;">
										${authPresets.map((preset) => {
											const writableScope = ctx.getWritableMcpScope(
												preset.scope,
											);
											const replaceHiddenHeaderValues =
												ctx.mcpEditingReplaceAuthPresetHeaders[preset.name] ===
												true;
											const canEditHeaderValues =
												(preset.headerKeys?.length ?? 0) === 0 ||
												replaceHiddenHeaderValues;
											const editableHeadersText =
												ctx.mcpEditingAuthPresetHeadersTexts[preset.name] ?? "";
											const editableHeadersHelper =
												ctx.mcpEditingAuthPresetHeadersHelpers[preset.name] ??
												preset.headersHelper ??
												"";
											return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">${preset.name}</div>
														<div class="panel-card-copy">
															${preset.scope ? ctx.formatMcpScopeLabel(preset.scope) : "Merged config"}
														</div>
													</div>
													${
														writableScope
															? html`<button
																	class="action-btn mcp-auth-preset-remove-button"
																	@click=${() =>
																		void ctx.removeMcpAuthPreset(
																			preset.name,
																			writableScope,
																		)}
																	?disabled=${ctx.mcpRemovingAuthPresetName === preset.name}
																>
																	${
																		ctx.mcpRemovingAuthPresetName ===
																		preset.name
																			? "Removing..."
																			: "Remove"
																	}
																</button>`
															: ""
													}
												</div>
												<div class="panel-card-copy">
													${preset.headersHelper ? html`Headers helper: ${preset.headersHelper}<br />` : ""}
													${
														preset.headerKeys.length > 0
															? html`Header keys: ${preset.headerKeys.join(", ")}`
															: html`No static headers configured.`
													}
												</div>
												${
													writableScope
														? html`
															<div class="control-row">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Headers helper (optional)"}
																	.value=${editableHeadersHelper}
																	aria-label=${`Headers helper for auth preset ${preset.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingAuthPresetHeadersHelpers = {
																			...ctx.mcpEditingAuthPresetHeadersHelpers,
																			[preset.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<button
																	class="action-btn mcp-auth-preset-save-button"
																	@click=${() =>
																		void ctx.updateMcpAuthPreset(
																			preset,
																			writableScope,
																		)}
																	?disabled=${ctx.mcpUpdatingAuthPresetName === preset.name}
																>
																	${
																		ctx.mcpUpdatingAuthPresetName ===
																		preset.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
																</div>
																<div class="control-row">
																	${
																		(preset.headerKeys?.length ?? 0) > 0
																			? html`
																				<label class="panel-card-copy">
																					<input
																						type="checkbox"
																						.checked=${replaceHiddenHeaderValues}
																						aria-label=${`Replace hidden headers for auth preset ${preset.name}`}
																						@change=${(event: Event) => {
																							const checked = (
																								event.target as HTMLInputElement
																							).checked;
																							ctx.mcpEditingReplaceAuthPresetHeaders =
																								checked
																									? {
																											...ctx.mcpEditingReplaceAuthPresetHeaders,
																											[preset.name]: true,
																										}
																									: Object.fromEntries(
																											Object.entries(
																												ctx.mcpEditingReplaceAuthPresetHeaders,
																											).filter(
																												([key]) =>
																													key !== preset.name,
																											),
																										);
																							if (!checked) {
																								ctx.mcpEditingAuthPresetHeadersTexts =
																									Object.fromEntries(
																										Object.entries(
																											ctx.mcpEditingAuthPresetHeadersTexts,
																										).filter(
																											([key]) =>
																												key !== preset.name,
																										),
																									);
																							}
																						}}
																					/>
																					${" "}Replace hidden header values
																				</label>
																			`
																			: ""
																	}
																</div>
																<div class="control-row">
																	<textarea
																		class="field-input"
																		style="min-height: 5.5rem;"
																		.placeholder=${"Headers (KEY=VALUE, one per line)"}
																		.value=${editableHeadersText}
																		?disabled=${!canEditHeaderValues}
																		aria-label=${`Headers for auth preset ${preset.name}`}
																		@input=${(event: Event) => {
																			ctx.mcpEditingAuthPresetHeadersTexts = {
																				...ctx.mcpEditingAuthPresetHeadersTexts,
																				[preset.name]: (
																					event.target as HTMLTextAreaElement
																				).value,
																			};
																		}}
																	></textarea>
																</div>
																<div class="panel-card-copy">
																	Header values stay hidden. ${
																		(preset.headerKeys?.length ?? 0) > 0 &&
																		!replaceHiddenHeaderValues
																			? 'Enable "Replace hidden header values" to edit them.'
																			: "Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them."
																	} Current keys: ${
																		preset.headerKeys.length > 0
																			? preset.headerKeys.join(", ")
																			: "none"
																	}.
															</div>
														`
														: ""
												}
											</div>
										`;
										})}
								</div>
							`
							: html`<div class="empty-state">No MCP auth presets configured</div>`
					}
					<div class="section" style="margin: 1rem 0;">
						<div class="section-header">
							<h3>New Auth Preset</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Create a reusable remote auth preset with hidden header values or
								a headers helper command.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Preset name"}
									.value=${ctx.mcpAuthPresetName}
									aria-label=${"MCP auth preset name"}
									@input=${(event: Event) => {
										ctx.mcpAuthPresetName = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<input
									class="field-input"
									type="text"
									.placeholder=${"Headers helper (optional)"}
									.value=${ctx.mcpAuthPresetHeadersHelper}
									aria-label=${"MCP auth preset headers helper"}
									@input=${(event: Event) => {
										ctx.mcpAuthPresetHeadersHelper = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
							</div>
							<div class="control-row">
								<textarea
									class="field-input"
									style="min-height: 5.5rem;"
									.placeholder=${"Headers (KEY=VALUE, one per line)"}
									.value=${ctx.mcpAuthPresetHeadersText}
									aria-label=${"MCP auth preset headers"}
									@input=${(event: Event) => {
										ctx.mcpAuthPresetHeadersText = (
											event.target as HTMLTextAreaElement
										).value;
									}}
								></textarea>
							</div>
							<div class="control-row">
								<select
									class="field-select"
									.value=${ctx.mcpAuthPresetScope}
									aria-label=${"MCP auth preset scope"}
									@change=${(event: Event) => {
										ctx.mcpAuthPresetScope = (event.target as HTMLSelectElement)
											.value as McpRegistryImportRequest["scope"];
									}}
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
								<button
									class="action-btn mcp-auth-preset-add-button"
									@click=${() => void ctx.addMcpAuthPreset()}
									?disabled=${
										ctx.mcpAuthPresetSubmitting ||
										ctx.mcpAuthPresetName.trim().length === 0 ||
										(ctx.mcpAuthPresetHeadersHelper.trim().length === 0 &&
											ctx.mcpAuthPresetHeadersText.trim().length === 0)
									}
								>
									${ctx.mcpAuthPresetSubmitting ? "Adding..." : "Add Preset"}
								</button>
							</div>
						</div>
					</div>
					<div class="control-row">
						<div>
							<div class="info-value">Configured Servers</div>
							<div class="info-label">Slash command: /mcp</div>
						</div>
					</div>
					${
						servers.length > 0
							? html`
								<div class="panel-grid">
									${servers.map((server) => {
										const writableScope = ctx.getWritableMcpScope(server.scope);
										const replaceHiddenEnvValues =
											ctx.mcpEditingReplaceEnv[server.name] === true;
										const replaceHiddenHeaderValues =
											ctx.mcpEditingReplaceHeaders[server.name] === true;
										const canEditEnvValues =
											(server.envKeys?.length ?? 0) === 0 ||
											replaceHiddenEnvValues;
										const canEditHeaderValues =
											(server.headerKeys?.length ?? 0) === 0 ||
											replaceHiddenHeaderValues;
										const editableTransport =
											ctx.mcpEditingTransports[server.name] ??
											(server.transport === "stdio"
												? "stdio"
												: server.transport === "sse"
													? "sse"
													: "http");
										const editableUrl =
											ctx.mcpEditingUrls[server.name] ?? server.remoteUrl ?? "";
										const editableCommand =
											ctx.mcpEditingCommands[server.name] ??
											server.command ??
											"";
										const editableArgsText =
											ctx.mcpEditingArgsText[server.name] ??
											ctx.formatMcpArgsText(server.args);
										const editableCwd =
											ctx.mcpEditingCwds[server.name] ?? server.cwd ?? "";
										const editableEnvText =
											ctx.mcpEditingEnvTexts[server.name] ?? "";
										const editableHeadersHelper =
											ctx.mcpEditingHeadersHelpers[server.name] ??
											server.headersHelper ??
											"";
										const editableAuthPreset =
											ctx.mcpEditingAuthPresets[server.name] ??
											server.authPreset ??
											"";
										const editableHeadersText =
											ctx.mcpEditingHeadersTexts[server.name] ?? "";
										const editableTimeout =
											ctx.mcpEditingTimeouts[server.name] ??
											ctx.formatMcpTimeoutText(server.timeout);
										const selectedResource =
											ctx.mcpSelectedResources[server.name] ??
											server.resources?.[0] ??
											"";
										const selectedPrompt =
											ctx.mcpSelectedPrompts[server.name] ??
											server.prompts?.[0] ??
											"";
										const selectedPromptDetail =
											server.promptDetails?.find(
												(prompt) => prompt.name === selectedPrompt,
											) ?? null;
										const promptArgsText =
											ctx.mcpPromptArgsText[server.name] ?? "";
										const resourceOutput =
											ctx.mcpResourceOutputs[server.name] ?? "";
										const promptOutput =
											ctx.mcpPromptOutputs[server.name] ?? "";
										const resourceError =
											ctx.mcpResourceErrors[server.name] ?? null;
										const promptError =
											ctx.mcpPromptErrors[server.name] ?? null;
										return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">${server.name}</div>
														<div class="panel-card-copy">
															${ctx.getMcpConnectionLabel(server)}
														</div>
													</div>
													${
														writableScope
															? html`<button
																	class="action-btn mcp-remove-button"
																	@click=${() =>
																		void ctx.removeMcpServer(
																			server.name,
																			writableScope,
																		)}
																	?disabled=${ctx.mcpRemovingName === server.name}
																>
																	${
																		ctx.mcpRemovingName === server.name
																			? "Removing..."
																			: "Remove"
																	}
																</button>`
															: ""
													}
												</div>
												<div class="panel-badges">
													${
														server.scope
															? html`<span class="badge">${server.scope}</span>`
															: ""
													}
													${
														ctx.formatMcpTransportLabel(server.transport)
															? html`<span class="badge active">${ctx.formatMcpTransportLabel(server.transport)}</span>`
															: ""
													}
													${
														ctx.formatMcpTrustLabel(server.remoteTrust)
															? html`<span class="badge">${ctx.formatMcpTrustLabel(server.remoteTrust)}</span>`
															: ""
													}
													${
														ctx.formatMcpProjectApprovalLabel(
															server.projectApproval,
														)
															? html`<span class="badge">${ctx.formatMcpProjectApprovalLabel(server.projectApproval)}</span>`
															: ""
													}
												</div>
												${
													server.projectApproval
														? html`
															<div class="panel-card-copy">
																Project approval:
																${ctx.formatMcpProjectApprovalLabel(
																	server.projectApproval,
																)}
																<br />
																Repo-provided MCP servers stay disconnected until
																they are approved locally.
															</div>
															<div class="control-row">
																${
																	server.projectApproval !== "approved"
																		? html`<button
																				class="action-btn"
																				@click=${() =>
																					void ctx.setMcpProjectApproval(
																						server.name,
																						"approved",
																					)}
																				?disabled=${
																					ctx.mcpProjectApprovalMutation
																						?.name === server.name
																				}
																			>
																				${
																					ctx.mcpProjectApprovalMutation
																						?.name === server.name &&
																					ctx.mcpProjectApprovalMutation
																						.decision === "approved"
																						? "Approving..."
																						: "Approve"
																				}
																			</button>`
																		: ""
																}
																${
																	server.projectApproval !== "denied"
																		? html`<button
																				class="action-btn"
																				@click=${() =>
																					void ctx.setMcpProjectApproval(
																						server.name,
																						"denied",
																					)}
																				?disabled=${
																					ctx.mcpProjectApprovalMutation
																						?.name === server.name
																				}
																			>
																				${
																					ctx.mcpProjectApprovalMutation
																						?.name === server.name &&
																					ctx.mcpProjectApprovalMutation
																						.decision === "denied"
																						? "Denying..."
																						: "Deny"
																				}
																			</button>`
																		: ""
																}
															</div>
														`
														: ""
												}
												${
													server.remoteHost || server.remoteUrl
														? html`
															<div class="panel-card-copy">
																${server.remoteHost ? html`Host: ${server.remoteHost}<br />` : ""}
																${server.remoteUrl ? html`URL: ${server.remoteUrl}` : ""}
															</div>
														`
														: ""
												}
												${
													server.command ||
													server.cwd ||
													(server.args?.length ?? 0) > 0
														? html`
															<div class="panel-card-copy">
																${server.command ? html`Command: ${server.command}<br />` : ""}
																${
																	(server.args?.length ?? 0) > 0
																		? html`Args: ${(server.args ?? []).join(" ")}<br />`
																		: ""
																}
																${server.cwd ? html`CWD: ${server.cwd}` : ""}
															</div>
														`
														: ""
												}
												${
													server.timeout ||
													server.headersHelper ||
													server.authPreset ||
													(server.envKeys?.length ?? 0) > 0 ||
													(server.headerKeys?.length ?? 0) > 0
														? html`
															<div class="panel-card-copy">
																${server.timeout ? html`Timeout: ${server.timeout} ms<br />` : ""}
																${server.authPreset ? html`Auth preset: ${server.authPreset}<br />` : ""}
																${server.headersHelper ? html`Headers helper: ${server.headersHelper}<br />` : ""}
																${
																	(server.envKeys?.length ?? 0) > 0
																		? html`Env keys: ${(server.envKeys ?? []).join(", ")}<br />`
																		: ""
																}
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? html`Header keys: ${(server.headerKeys ?? []).join(", ")}`
																		: ""
																}
															</div>
														`
														: ""
												}
												${
													writableScope && server.remoteUrl
														? html`
															<div class="control-row">
																<input
																	class="field-input"
																	type="url"
																	.placeholder=${"https://example.com/mcp"}
																	.value=${editableUrl}
																	aria-label=${`Remote URL for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingUrls = {
																			...ctx.mcpEditingUrls,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<select
																	class="field-select"
																	.value=${editableTransport}
																	aria-label=${`Remote transport for ${server.name}`}
																	@change=${(event: Event) => {
																		ctx.mcpEditingTransports = {
																			...ctx.mcpEditingTransports,
																			[server.name]: (
																				event.target as HTMLSelectElement
																			).value as "stdio" | "http" | "sse",
																		};
																	}}
																>
																	<option value="http">HTTP</option>
																	<option value="sse">SSE</option>
																</select>
																<select
																	class="field-select"
																	.value=${editableAuthPreset}
																	aria-label=${`Auth preset for ${server.name}`}
																	@change=${(event: Event) => {
																		ctx.mcpEditingAuthPresets = {
																			...ctx.mcpEditingAuthPresets,
																			[server.name]: (
																				event.target as HTMLSelectElement
																			).value,
																		};
																	}}
																>
																	<option value="">No auth preset</option>
																	${authPresets.map(
																		(
																			preset,
																		) => html`<option value=${preset.name}>
																			${preset.name}
																		</option>`,
																	)}
																</select>
																<button
																	class="action-btn mcp-update-button"
																	@click=${() =>
																		void ctx.updateMcpServer(
																			server,
																			writableScope,
																		)}
																	?disabled=${ctx.mcpUpdatingName === server.name}
																>
																	${
																		ctx.mcpUpdatingName === server.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
															</div>
															<div class="control-row">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Headers helper (optional)"}
																	.value=${editableHeadersHelper}
																	aria-label=${`Headers helper for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingHeadersHelpers = {
																			...ctx.mcpEditingHeadersHelpers,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<input
																	class="field-input"
																	type="number"
																	min="1"
																	.placeholder=${"Timeout (ms)"}
																	.value=${editableTimeout}
																	aria-label=${`Timeout for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingTimeouts = {
																			...ctx.mcpEditingTimeouts,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
															</div>
															<div class="control-row">
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? html`
																			<label class="panel-card-copy">
																				<input
																					type="checkbox"
																					.checked=${replaceHiddenHeaderValues}
																					aria-label=${`Replace hidden headers for ${server.name}`}
																					@change=${(event: Event) => {
																						const checked = (
																							event.target as HTMLInputElement
																						).checked;
																						ctx.mcpEditingReplaceHeaders =
																							checked
																								? {
																										...ctx.mcpEditingReplaceHeaders,
																										[server.name]: true,
																									}
																								: Object.fromEntries(
																										Object.entries(
																											ctx.mcpEditingReplaceHeaders,
																										).filter(
																											([key]) =>
																												key !== server.name,
																										),
																									);
																						if (!checked) {
																							ctx.mcpEditingHeadersTexts =
																								Object.fromEntries(
																									Object.entries(
																										ctx.mcpEditingHeadersTexts,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						}
																					}}
																				/>
																				${" "}Replace hidden header values
																			</label>
																		`
																		: ""
																}
															</div>
															<div class="control-row">
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Headers (KEY=VALUE, one per line)"}
																	.value=${editableHeadersText}
																	?disabled=${!canEditHeaderValues}
																	aria-label=${`Headers for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingHeadersTexts = {
																			...ctx.mcpEditingHeadersTexts,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
															</div>
															<div class="panel-card-copy">
																${
																	(server.headerKeys?.length ?? 0) > 0
																		? replaceHiddenHeaderValues
																			? html`Header values stay hidden. Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them. Current keys: ${(server.headerKeys ?? []).join(", ")}.`
																			: html`Header values stay hidden and will be preserved unless you enable replacement. Current keys: ${(server.headerKeys ?? []).join(", ")}.`
																		: html`Enter KEY=VALUE lines to set headers for this server.`
																}
																<br />
																Delete optional values like timeout or headers
																helper, or select "No auth preset", then save to clear
																them.
															</div>
															<div class="panel-card-copy">
																Edits apply to the ${ctx.formatMcpScopeLabel(
																	writableScope,
																)} config file.
															</div>
														`
														: ""
												}
												${
													writableScope && server.transport === "stdio"
														? html`
															<div class="control-row" style="align-items: stretch;">
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Command"}
																	.value=${editableCommand}
																	aria-label=${`Command for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingCommands = {
																			...ctx.mcpEditingCommands,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Arguments (one per line)"}
																	.value=${editableArgsText}
																	aria-label=${`Arguments for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingArgsText = {
																			...ctx.mcpEditingArgsText,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
																<textarea
																	class="field-input"
																	style="min-height: 5.5rem;"
																	.placeholder=${"Env vars (KEY=VALUE, one per line)"}
																	.value=${editableEnvText}
																	?disabled=${!canEditEnvValues}
																	aria-label=${`Environment variables for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingEnvTexts = {
																			...ctx.mcpEditingEnvTexts,
																			[server.name]: (
																				event.target as HTMLTextAreaElement
																			).value,
																		};
																	}}
																></textarea>
																<input
																	class="field-input"
																	type="text"
																	.placeholder=${"Working directory (optional)"}
																	.value=${editableCwd}
																	aria-label=${`Working directory for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingCwds = {
																			...ctx.mcpEditingCwds,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<input
																	class="field-input"
																	type="number"
																	min="1"
																	.placeholder=${"Timeout (ms)"}
																	.value=${editableTimeout}
																	aria-label=${`Timeout for ${server.name}`}
																	@input=${(event: Event) => {
																		ctx.mcpEditingTimeouts = {
																			...ctx.mcpEditingTimeouts,
																			[server.name]: (
																				event.target as HTMLInputElement
																			).value,
																		};
																	}}
																/>
																<button
																	class="action-btn mcp-update-button"
																	@click=${() =>
																		void ctx.updateMcpServer(
																			server,
																			writableScope,
																		)}
																	?disabled=${ctx.mcpUpdatingName === server.name || editableCommand.trim().length === 0}
																>
																	${
																		ctx.mcpUpdatingName === server.name
																			? "Saving..."
																			: "Save"
																	}
																</button>
															</div>
															${
																(server.envKeys?.length ?? 0) > 0
																	? html`
																		<div class="control-row">
																			<label class="panel-card-copy">
																				<input
																					type="checkbox"
																					.checked=${replaceHiddenEnvValues}
																					aria-label=${`Replace hidden environment variables for ${server.name}`}
																					@change=${(event: Event) => {
																						const checked = (
																							event.target as HTMLInputElement
																						).checked;
																						ctx.mcpEditingReplaceEnv = checked
																							? {
																									...ctx.mcpEditingReplaceEnv,
																									[server.name]: true,
																								}
																							: Object.fromEntries(
																									Object.entries(
																										ctx.mcpEditingReplaceEnv,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						if (!checked) {
																							ctx.mcpEditingEnvTexts =
																								Object.fromEntries(
																									Object.entries(
																										ctx.mcpEditingEnvTexts,
																									).filter(
																										([key]) =>
																											key !== server.name,
																									),
																								);
																						}
																					}}
																				/>
																				${" "}Replace hidden environment values
																			</label>
																		</div>
																	`
																	: ""
															}
															<div class="panel-card-copy">
																${
																	(server.envKeys?.length ?? 0) > 0
																		? replaceHiddenEnvValues
																			? html`Env values stay hidden. Enter KEY=VALUE lines to replace them. Leave the field blank and save to clear them. Current keys: ${(server.envKeys ?? []).join(", ")}.`
																			: html`Env values stay hidden and will be preserved unless you enable replacement. Current keys: ${(server.envKeys ?? []).join(", ")}.`
																		: html`Enter KEY=VALUE lines to set environment variables for this server.`
																}
																<br />
																Delete optional values like args, cwd, env vars, or
																timeout, then save, to clear them.
															</div>
															<div class="panel-card-copy">
																Edits apply to the ${ctx.formatMcpScopeLabel(
																	writableScope,
																)} config file.
															</div>
														`
														: ""
												}
												${
													server.officialRegistry?.displayName
														? html`
															<div class="panel-card-copy">
																Official registry: ${server.officialRegistry.displayName}
																${
																	server.officialRegistry.authorName
																		? html`<br />Author: ${server.officialRegistry.authorName}`
																		: ""
																}
															</div>
															<div class="panel-link-row">
																${
																	server.officialRegistry.directoryUrl
																		? html`<a
																				href=${server.officialRegistry.directoryUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Directory
																			</a>`
																		: ""
																}
																${
																	server.officialRegistry.documentationUrl
																		? html`<a
																				href=${server.officialRegistry.documentationUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Docs
																			</a>`
																		: ""
																}
															</div>
														`
														: ""
												}
												${
													(server.resources?.length ?? 0) > 0
														? html`
															<div class="section" style="margin: 0;">
																<div class="section-header">
																	<h3>Resources</h3>
																</div>
																<div class="section-content">
																	<div class="control-row">
																		<select
																			class="field-select"
																			.value=${selectedResource}
																			aria-label=${`MCP resource for ${server.name}`}
																			@change=${(event: Event) => {
																				ctx.mcpSelectedResources = {
																					...ctx.mcpSelectedResources,
																					[server.name]: (
																						event.target as HTMLSelectElement
																					).value,
																				};
																			}}
																		>
																			${(server.resources ?? []).map(
																				(
																					resource,
																				) => html`<option value=${resource}>
																					${resource}
																				</option>`,
																			)}
																		</select>
																		<button
																			class="action-btn"
																			aria-label=${`Read resource for ${server.name}`}
																			@click=${() =>
																				void ctx.readMcpResource(
																					server,
																					selectedResource,
																				)}
																			?disabled=${ctx.mcpReadingResourceName === server.name || !selectedResource}
																		>
																			${
																				ctx.mcpReadingResourceName ===
																				server.name
																					? "Loading..."
																					: "Read Resource"
																			}
																		</button>
																	</div>
																	${
																		resourceError
																			? html`<div class="panel-feedback error">${resourceError}</div>`
																			: ""
																	}
																	${
																		resourceOutput
																			? html`<pre class="panel-code-block">${resourceOutput}</pre>`
																			: ""
																	}
																</div>
															</div>
														`
														: ""
												}
												${
													(server.prompts?.length ?? 0) > 0
														? html`
															<div class="section" style="margin: 0;">
																<div class="section-header">
																	<h3>Prompts</h3>
																</div>
																<div class="section-content">
																	<div class="control-row">
																		<select
																			class="field-select"
																			.value=${selectedPrompt}
																			aria-label=${`MCP prompt for ${server.name}`}
																			@change=${(event: Event) => {
																				ctx.mcpSelectedPrompts = {
																					...ctx.mcpSelectedPrompts,
																					[server.name]: (
																						event.target as HTMLSelectElement
																					).value,
																				};
																			}}
																			>
																				${(server.prompts ?? []).map(
																					(prompt) => {
																						const promptDetail =
																							server.promptDetails?.find(
																								(detail) =>
																									detail.name === prompt,
																							);
																						return html`<option value=${prompt}>
																							${promptDetail?.title ?? prompt}
																						</option>`;
																					},
																				)}
																			</select>
																			<button
																			class="action-btn"
																			aria-label=${`Run prompt for ${server.name}`}
																			@click=${() =>
																				void ctx.getMcpPrompt(
																					server,
																					selectedPrompt,
																				)}
																			?disabled=${ctx.mcpGettingPromptName === server.name || !selectedPrompt}
																			>
																				${
																					ctx.mcpGettingPromptName ===
																					server.name
																						? "Running..."
																						: "Run Prompt"
																				}
																			</button>
																		</div>
																		${
																			selectedPromptDetail?.description
																				? html`<div class="panel-card-copy">${selectedPromptDetail.description}</div>`
																				: ""
																		}
																		${
																			(
																				selectedPromptDetail?.arguments
																					?.length ?? 0
																			) > 0
																				? html`
																					<div class="section-content" style="padding: 0;">
																						${(
																							selectedPromptDetail?.arguments ??
																								[]
																						).map((argument) => {
																							const argumentKey =
																								ctx.getMcpPromptArgumentValueKey(
																									server.name,
																									selectedPrompt,
																									argument.name,
																								);
																							return html`
																									<label class="section" style="margin: 0 0 0.75rem 0;">
																										<div class="section-header">
																											<h3>
																												${argument.name}${
																													argument.required
																														? " (required)"
																														: ""
																												}
																											</h3>
																										</div>
																										<div class="section-content">
																											<input
																												class="field-input"
																												type="text"
																												.placeholder=${
																													argument.description ??
																													argument.name
																												}
																												.value=${
																													ctx
																														.mcpPromptArgumentValues[
																														argumentKey
																													] ?? ""
																												}
																												aria-label=${`Prompt argument ${argument.name} for ${server.name}`}
																												@input=${(
																													event: Event,
																												) => {
																													ctx.mcpPromptArgumentValues =
																														{
																															...ctx.mcpPromptArgumentValues,
																															[argumentKey]: (
																																event.target as HTMLInputElement
																															).value,
																														};
																												}}
																											/>
																											${
																												argument.description
																													? html`<div class="panel-card-copy">${argument.description}</div>`
																													: ""
																											}
																										</div>
																									</label>
																								`;
																						})}
																					</div>
																				`
																				: selectedPromptDetail
																					? ""
																					: html`
																						<div class="control-row">
																							<textarea
																								class="field-input"
																								style="min-height: 5.5rem;"
																								.placeholder=${"Prompt args (KEY=VALUE, one per line)"}
																								.value=${promptArgsText}
																								aria-label=${`Prompt arguments for ${server.name}`}
																								@input=${(event: Event) => {
																									ctx.mcpPromptArgsText = {
																										...ctx.mcpPromptArgsText,
																										[server.name]: (
																											event.target as HTMLTextAreaElement
																										).value,
																									};
																								}}
																							></textarea>
																						</div>
																					`
																		}
																		${
																			promptError
																				? html`<div class="panel-feedback error">${promptError}</div>`
																				: ""
																		}
																	${
																		promptOutput
																			? html`<pre class="panel-code-block">${promptOutput}</pre>`
																			: ""
																	}
																</div>
															</div>
														`
														: ""
												}
											</div>
										`;
									})}
								</div>
							`
							: html`<div class="empty-state">No MCP servers configured</div>`
					}
					<div class="section" style="margin: 1rem 0 0;">
						<div class="section-header">
							<h3>Custom Server</h3>
						</div>
						<div class="section-content">
							<div class="panel-card-copy">
								Add a stdio command or arbitrary HTTP/SSE MCP endpoint to local,
								project, or user config.
							</div>
							<div class="control-row" style="margin-top: 0.75rem;">
								<input
									class="field-input"
									type="text"
									.placeholder=${"Server name"}
									.value=${ctx.mcpCustomName}
									@input=${(event: Event) => {
										ctx.mcpCustomName = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								${
									ctx.mcpCustomTransport === "stdio"
										? html`
											<input
												class="field-input"
												type="text"
												.placeholder=${"Command"}
												.value=${ctx.mcpCustomCommand}
												aria-label=${"Custom MCP server command"}
												@input=${(event: Event) => {
													ctx.mcpCustomCommand = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Arguments (one per line)"}
												.value=${ctx.mcpCustomArgsText}
												aria-label=${"Custom MCP server arguments"}
												@input=${(event: Event) => {
													ctx.mcpCustomArgsText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
											<input
												class="field-input"
												type="text"
												.placeholder=${"Working directory (optional)"}
												.value=${ctx.mcpCustomCwd}
												aria-label=${"Custom MCP server working directory"}
												@input=${(event: Event) => {
													ctx.mcpCustomCwd = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Env vars (KEY=VALUE, one per line)"}
												.value=${ctx.mcpCustomEnvText}
												aria-label=${"Custom MCP server environment variables"}
												@input=${(event: Event) => {
													ctx.mcpCustomEnvText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
										`
										: html`
											<input
												class="field-input"
												type="url"
												.placeholder=${"https://example.com/mcp"}
												.value=${ctx.mcpCustomUrl}
												@input=${(event: Event) => {
													ctx.mcpCustomUrl = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<input
												class="field-input"
												type="text"
												.placeholder=${"Headers helper (optional)"}
												.value=${ctx.mcpCustomHeadersHelper}
												aria-label=${"Custom MCP server headers helper"}
												@input=${(event: Event) => {
													ctx.mcpCustomHeadersHelper = (
														event.target as HTMLInputElement
													).value;
												}}
											/>
											<select
												class="field-select"
												.value=${ctx.mcpCustomAuthPreset}
												aria-label=${"Custom MCP server auth preset"}
												@change=${(event: Event) => {
													ctx.mcpCustomAuthPreset = (
														event.target as HTMLSelectElement
													).value;
												}}
											>
												<option value="">No auth preset</option>
												${authPresets.map(
													(preset) => html`<option value=${preset.name}>
														${preset.name}
													</option>`,
												)}
											</select>
											<textarea
												class="field-input"
												style="min-height: 5.5rem;"
												.placeholder=${"Headers (KEY=VALUE, one per line)"}
												.value=${ctx.mcpCustomHeadersText}
												aria-label=${"Custom MCP server headers"}
												@input=${(event: Event) => {
													ctx.mcpCustomHeadersText = (
														event.target as HTMLTextAreaElement
													).value;
												}}
											></textarea>
										`
								}
							</div>
							<div class="control-row">
								<select
									class="field-select"
									.value=${ctx.mcpCustomTransport}
									aria-label=${"Custom MCP server transport"}
									@change=${(event: Event) => {
										ctx.mcpCustomTransport = (event.target as HTMLSelectElement)
											.value as "stdio" | "http" | "sse";
									}}
								>
									<option value="stdio">stdio</option>
									<option value="http">HTTP</option>
									<option value="sse">SSE</option>
								</select>
								<select
									class="field-select"
									.value=${ctx.mcpCustomScope}
									aria-label=${"Custom MCP server scope"}
									@change=${(event: Event) => {
										ctx.mcpCustomScope = (event.target as HTMLSelectElement)
											.value as McpRegistryImportRequest["scope"];
									}}
								>
									<option value="local">Local config</option>
									<option value="project">Project config</option>
									<option value="user">User config</option>
								</select>
								<input
									class="field-input"
									type="number"
									min="1"
									.placeholder=${"Timeout (ms)"}
									.value=${ctx.mcpCustomTimeoutText}
									aria-label=${"Custom MCP server timeout"}
									@input=${(event: Event) => {
										ctx.mcpCustomTimeoutText = (
											event.target as HTMLInputElement
										).value;
									}}
								/>
								<button
									class="action-btn mcp-custom-add-button"
									@click=${() => void ctx.addCustomMcpServer()}
									?disabled=${
										ctx.mcpCustomSubmitting ||
										ctx.mcpCustomName.trim().length === 0 ||
										(ctx.mcpCustomTransport === "stdio"
											? ctx.mcpCustomCommand.trim().length === 0
											: ctx.mcpCustomUrl.trim().length === 0)
									}
								>
									${ctx.mcpCustomSubmitting ? "Adding..." : "Add Server"}
								</button>
							</div>
							${
								ctx.mcpManagementError
									? html`<div class="panel-feedback error">${ctx.mcpManagementError}</div>`
									: ""
							}
							${
								ctx.mcpManagementNotice
									? html`<div class="panel-feedback success">${ctx.mcpManagementNotice}</div>`
									: ""
							}
						</div>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Official Registry</h3>
				</div>
				<div class="section-content">
					<div class="control-row">
						<input
							class="field-input mcp-search-input"
							type="text"
							.placeholder=${"Search official MCP registry"}
							.value=${ctx.mcpRegistryQuery}
							@input=${(event: Event) => {
								ctx.mcpRegistryQuery = (event.target as HTMLInputElement).value;
							}}
						/>
						<select
							class="field-select"
							.value=${ctx.mcpRegistryScope}
							@change=${(event: Event) => {
								ctx.mcpRegistryScope = (event.target as HTMLSelectElement)
									.value as McpRegistryImportRequest["scope"];
							}}
						>
							<option value="local">Local config</option>
							<option value="project">Project config</option>
							<option value="user">User config</option>
						</select>
						<button
							class="action-btn"
							@click=${() => void ctx.searchMcpRegistry(ctx.mcpRegistryQuery)}
							?disabled=${ctx.mcpRegistryLoading}
						>
							${ctx.mcpRegistryLoading ? "Searching..." : "Search"}
						</button>
						<button
							class="action-btn"
							@click=${() => {
								ctx.mcpRegistryQuery = "";
								void ctx.searchMcpRegistry("");
							}}
							?disabled=${ctx.mcpRegistryLoading}
						>
							Top Picks
						</button>
					</div>
					<div class="panel-card-copy">
						Imports target the ${ctx.formatMcpScopeLabel(ctx.mcpRegistryScope)}
						config by default.
					</div>
					${
						ctx.mcpRegistryError
							? html`<div class="panel-feedback error">${ctx.mcpRegistryError}</div>`
							: ""
					}
					${
						ctx.mcpRegistryNotice
							? html`<div class="panel-feedback success">${ctx.mcpRegistryNotice}</div>`
							: ""
					}
					${
						ctx.mcpRegistryEntries.length > 0
							? html`
								<div class="panel-grid">
									${ctx.mcpRegistryEntries.map((entry, index) => {
										const entryId = ctx.getMcpRegistryEntryId(entry, index);
										const urlOptions = ctx.getMcpRegistryUrlOptions(entry);
										const selectedUrl =
											ctx.mcpRegistrySelectedUrls[entryId] ||
											urlOptions[0]?.url ||
											"";
										const transportLabel = ctx.formatMcpTransportLabel(
											entry.transport,
										);
										const countBits = [
											typeof entry.toolCount === "number"
												? ctx.formatCountLabel(entry.toolCount, "tool", "tools")
												: null,
											typeof entry.promptCount === "number"
												? ctx.formatCountLabel(
														entry.promptCount,
														"prompt",
														"prompts",
													)
												: null,
										].filter((value): value is string => Boolean(value));
										return html`
											<div class="panel-card">
												<div class="panel-card-header">
													<div>
														<div class="panel-card-title">
															${
																entry.displayName ||
																entry.serverName ||
																entry.slug ||
																"Unnamed registry entry"
															}
														</div>
														${
															entry.oneLiner
																? html`<div class="panel-card-copy">${entry.oneLiner}</div>`
																: ""
														}
													</div>
													<button
														class="action-btn mcp-import-button"
														@click=${() => void ctx.importMcpRegistry(entry, index)}
														?disabled=${Boolean(
															ctx.mcpImportingId &&
																ctx.mcpImportingId !== entryId,
														)}
													>
														${
															ctx.mcpImportingId === entryId
																? "Importing..."
																: "Import"
														}
													</button>
												</div>
												<div class="panel-badges">
													${
														transportLabel
															? html`<span class="badge active">${transportLabel}</span>`
															: ""
													}
													${
														countBits.length > 0
															? html`<span class="badge">${countBits.join(" · ")}</span>`
															: ""
													}
													${
														entry.authorName
															? html`<span class="badge">by ${entry.authorName}</span>`
															: ""
													}
												</div>
												<input
													class="field-input"
													type="text"
													.placeholder=${"Name override (optional)"}
													.value=${ctx.mcpRegistryNames[entryId] ?? ""}
													@input=${(event: Event) => {
														ctx.mcpRegistryNames = {
															...ctx.mcpRegistryNames,
															[entryId]: (event.target as HTMLInputElement)
																.value,
														};
													}}
												/>
												${
													urlOptions.length > 1
														? html`
															<select
																class="field-select"
																.value=${selectedUrl}
																@change=${(event: Event) => {
																	ctx.mcpRegistrySelectedUrls = {
																		...ctx.mcpRegistrySelectedUrls,
																		[entryId]: (
																			event.target as HTMLSelectElement
																		).value,
																	};
																}}
															>
																${urlOptions.map(
																	(option) => html`
																		<option value=${option.url}>
																			${option.label}
																		</option>
																	`,
																)}
															</select>
														`
														: html`
															<div class="panel-card-copy">
																${
																	selectedUrl ||
																	"Default endpoint provided by registry"
																}
															</div>
														`
												}
												${
													entry.permissions
														? html`<div class="panel-card-copy">
																Permissions: ${entry.permissions}
															</div>`
														: ""
												}
												${
													entry.directoryUrl || entry.documentationUrl
														? html`
															<div class="panel-link-row">
																${
																	entry.directoryUrl
																		? html`<a
																				href=${entry.directoryUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Directory
																			</a>`
																		: ""
																}
																${
																	entry.documentationUrl
																		? html`<a
																				href=${entry.documentationUrl}
																				target="_blank"
																				rel="noreferrer"
																			>
																				Docs
																			</a>`
																		: ""
																}
															</div>
														`
														: ""
												}
											</div>
										`;
									})}
								</div>
							`
							: html`<div class="empty-state">
									${
										ctx.mcpRegistryLoading
											? "Loading official MCP registry..."
											: "No official registry matches"
									}
								</div>`
					}
				</div>
			</div>
		`;
}
