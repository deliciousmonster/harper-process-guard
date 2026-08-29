// Narrowing helpers for catch variables, so no site reads `unknown` on faith with a cast.

/** The thrown value's message. A non-Error throw (a string, a null from a native binding) still yields text. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The errno code of a thrown value, or undefined when there is none to read. */
export function errnoCode(error: unknown): string | undefined {
	return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
