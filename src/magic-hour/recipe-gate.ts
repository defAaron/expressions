export function assertRecipePresent(readRecipe: () => string | undefined): void {
  if (readRecipe() === undefined) {
    throw new Error("Recipe is missing.");
  }
}
