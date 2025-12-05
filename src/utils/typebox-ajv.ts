import {
	type Static,
	type TSchema,
	type TUnsafe,
	Type,
} from "@sinclair/typebox";
import AjvModule, { Ajv as AjvClass, type AnySchema } from "ajv";

// ESM/CJS interop: extract constructor from module (may be nested under .default)
const Ajv =
	(AjvModule as unknown as { default?: typeof AjvClass }).default ?? AjvClass;

const ajv = new Ajv({
	allErrors: true,
	useDefaults: true,
	strict: false,
	allowUnionTypes: true,
});

export function compileTypeboxSchema<T extends TSchema>(schema: T) {
	return ajv.compile<Static<T>>(schema as AnySchema);
}

export type CompileResult<T extends TSchema> = ReturnType<
	typeof compileTypeboxSchema<T>
>;

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as unknown as string[],
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
