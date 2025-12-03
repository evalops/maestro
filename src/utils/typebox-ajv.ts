import type { Static, TSchema } from "@sinclair/typebox";
import AjvPkg from "ajv";
import type { Ajv as AjvInstance } from "ajv";

// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any for constructor type
const AjvConstructor: new (options?: any) => AjvInstance =
	// biome-ignore lint/suspicious/noExplicitAny: ESM/CJS interop requires any for module default
	((AjvPkg as any).default ?? AjvPkg) as any;

const ajv = new AjvConstructor({
	allErrors: true,
	useDefaults: true,
	strict: false,
	allowUnionTypes: true,
});

export function compileTypeboxSchema<T extends TSchema>(schema: T) {
	// biome-ignore lint/suspicious/noExplicitAny: TypeBox TSchema not directly assignable to AJV schema type
	return ajv.compile<Static<T>>(schema as any);
}

export type CompileResult<T extends TSchema> = ReturnType<
	typeof compileTypeboxSchema<T>
>;
