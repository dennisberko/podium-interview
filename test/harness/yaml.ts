/**
 * Template tag for inline YAML: strips the common indentation so config can
 * be written indented inside test code.
 *
 *   yaml`
 *     routes:
 *       - path: /api
 *   `
 */
export function yaml(
  strings: TemplateStringsArray,
  ...values: (string | number)[]
): string {
  const lines = String.raw(strings, ...values).split("\n");
  const margin = Math.min(
    ...lines
      .filter((line) => line.trim() !== "")
      .map((line) => line.length - line.trimStart().length),
  );
  return lines.map((line) => line.slice(margin)).join("\n");
}
