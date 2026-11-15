/** Custom condition names, kept apart from the evaluators so the schema can check them. */
export const customConditions = new Set<string>();

export const isCustomCondition = (type: string): boolean => customConditions.has(type);
