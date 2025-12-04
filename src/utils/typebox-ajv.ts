import type { Static, TSchema } from "@sinclair/typebox";
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
