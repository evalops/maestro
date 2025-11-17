import type { Static, TSchema } from "@sinclair/typebox";
import AjvPkg from "ajv";
import type { Ajv as AjvInstance } from "ajv";

const AjvConstructor: new (options?: any) => AjvInstance = ((AjvPkg as any)
	.default ?? AjvPkg) as any;

const ajv = new AjvConstructor({
	allErrors: true,
	useDefaults: true,
	strict: false,
	allowUnionTypes: true,
});

export function compileTypeboxSchema<T extends TSchema>(schema: T) {
	return ajv.compile<Static<T>>(schema as any);
}

export type CompileResult<T extends TSchema> = ReturnType<
	typeof compileTypeboxSchema<T>
>;
