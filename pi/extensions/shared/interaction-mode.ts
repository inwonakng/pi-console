import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type InteractionMode = "interactive" | "noninteractive";

const INTERACTION_MODES: InteractionMode[] = ["interactive", "noninteractive"];

export function parseInteractionMode(input: string | undefined): InteractionMode | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  return INTERACTION_MODES.find((mode) => mode === value);
}

export function getInteractionMode(ctx: Pick<ExtensionContext, "hasUI">): InteractionMode {
  return parseInteractionMode(process.env.PI_INTERACTION_MODE)
    ?? (ctx.hasUI ? "interactive" : "noninteractive");
}
