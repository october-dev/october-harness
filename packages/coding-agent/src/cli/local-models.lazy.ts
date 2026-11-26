/** Loads `october local-models` only when the command runs (see local-models.ts). */
export const loadLocalModelsCommand = () => import("./local-models.ts");
