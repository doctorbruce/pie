// Adapted from pi coding-agent at b2602be (MIT). See README.md for extraction boundaries.
/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
