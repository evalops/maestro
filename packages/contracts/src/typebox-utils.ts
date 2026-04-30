import { type TSchema, Type } from "@sinclair/typebox";

export function stringLiteralUnion<const T extends readonly string[]>(
	values: T,
) {
	return Type.Unsafe<T[number]>(
		Type.Union(
			values.map((value) => Type.Literal(value)) as unknown as [
				TSchema,
				...TSchema[],
			],
		),
	);
}
