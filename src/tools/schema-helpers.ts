import { z } from "zod";

export const zPathParameter = (
	description = "Path to the file (relative or absolute)",
) => z.string({ description }).min(1, "Path must not be empty");

export const zOptionalPathParameter = (
	description = "Optional path (relative or absolute)",
) => zPathParameter(description).optional();

export const zPatternParameter = (
	description = "Glob pattern relative to the directory",
) => z.string({ description }).min(1, "Pattern must not be empty");

export const zLimitParameter = (
	max: number,
	description = `Maximum number of entries to return (1-${max})`,
) => z.number({ description }).int().min(1).max(max);

export const zOptionalBooleanFlag = (description: string) =>
	z.boolean({ description }).optional();
